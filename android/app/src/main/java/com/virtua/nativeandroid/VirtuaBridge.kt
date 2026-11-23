package com.virtua.nativeandroid

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.lifecycleScope
import dev.ffmpegkit.llama.Llama
import dev.ffmpegkit.llama.LlamaConfig
import dev.ffmpegkit.llama.LlamaModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/**
 * JavaScript bridge exposed to the local WebView as `VirtuaNative`.
 *
 * Every call returns through `window.__virtuaNativeCallback(callbackId, jsonResult)`
 * with either {"ok":true,"value":...} or {"ok":false,"error":"..."}.
 */
class VirtuaBridge(
    private val activity: MainActivity,
    private val webView: WebView,
) {
    private object NoCallback

    private val modelsDir: File get() = File(activity.filesDir, "models")
    private val avatarsDir: File get() = File(activity.filesDir, "avatars")

    private val inferenceMutex = Mutex()
    private var loadedModel: LlamaModel? = null
    private var loadedPath: String? = null
    private val activeRequests = ConcurrentHashMap<String, Job>()

    /** Set by MainActivity when a virtua://pair deep link is scanned or opened. */
    @Volatile
    private var pendingPair: String? = null

    fun setPendingPair(json: String) {
        pendingPair = json
    }

    @JavascriptInterface
    fun consumePair(): String? {
        val value = pendingPair
        pendingPair = null
        return value
    }

    @JavascriptInterface
    fun call(method: String, argsJson: String, callbackId: String) {
        val parsedArgs = runCatching { JSONObject(argsJson.ifBlank { "{}" }) }
        if (parsedArgs.isFailure) {
            postError(callbackId, parsedArgs.exceptionOrNull() ?: IllegalStateException("Bad arguments"))
            return
        }

        // Always asynchronous from the WebView's point of view.
        activity.lifecycleScope.launch(Dispatchers.Default) {
            val outcome = runCatching { dispatch(method, parsedArgs.getOrThrow(), callbackId) }
            val value = outcome.getOrNull()
            when {
                outcome.exceptionOrNull() is CancellationException -> Unit // Cancelled by the user.
                outcome.isFailure -> postError(callbackId, outcome.exceptionOrNull()!!)
                value === NoCallback -> Unit // SAF method posts when the result arrives.
                else -> postOk(callbackId, value as Any)
            }
        }
    }

    private suspend fun dispatch(method: String, args: JSONObject, callbackId: String): Any =
        when (method) {
            "models" -> listModels()
            "pickModel" -> launchOnMain { activity.launchPickModel(callbackId) }
            "loadModel" -> loadModel(args)
            "complete" -> complete(args, callbackId)
            "cancel" -> cancel(args)
            "pickVrm" -> launchOnMain { activity.launchPickVrm(callbackId) }
            "scanQr" -> launchOnMain { activity.launchQrScanner(callbackId) }
            "speak" -> speak(args.optString("text"))
            "importBundleFromSaf" -> launchOnMain { activity.launchImportBundle(callbackId) }
            "exportBundleToSaf" -> launchOnMain {
                activity.launchExport(callbackId, args.optString("json"))
            }
            else -> throw IllegalArgumentException("Unknown native method: $method")
        }

    private suspend fun launchOnMain(block: () -> Unit): Any {
        withContext(Dispatchers.Main) { block() }
        return NoCallback
    }

    // ---------------------------------------------------------------------
    // Local files
    // ---------------------------------------------------------------------

    private fun listModels(): JSONArray {
        val dir = modelsDir
        if (!dir.exists()) return JSONArray()
        return JSONArray().apply {
            dir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(".gguf", ignoreCase = true) }
                ?.sortedBy { it.name.lowercase(Locale.ROOT) }
                ?.forEach { file ->
                    put(
                        JSONObject()
                            .put("name", file.name)
                            .put("path", file.absolutePath)
                            .put("size", file.length()),
                    )
                }
        }
    }

    fun onModelPicked(callbackId: String, uri: Uri?) = handleSafResult(callbackId) {
        if (uri == null) throw IllegalStateException("No model file was selected")
        val displayName = queryDisplayName(uri) ?: "model.gguf"
        val destination = copyToPrivate(uri, modelsDir, displayName, ".gguf")
        JSONObject()
            .put("name", displayName)
            .put("path", destination.absolutePath)
            .put("size", destination.length())
    }

    fun onVrmPicked(callbackId: String, uri: Uri?) = handleSafResult(callbackId) {
        if (uri == null) throw IllegalStateException("No VRM file was selected")
        val displayName = queryDisplayName(uri) ?: "avatar.vrm"
        val destination = copyToPrivate(uri, avatarsDir, displayName, ".vrm")
        JSONObject()
            .put("name", displayName)
            .put("path", destination.absolutePath)
            .put("dataBase64", encodeBase64(destination))
    }

    fun onBundleImported(callbackId: String, treeUri: Uri?) = handleSafResult(callbackId) {
        if (treeUri == null) throw IllegalStateException("No backup folder was selected")
        runCatching {
            activity.contentResolver.takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        }

        val root = DocumentFile.fromTreeUri(activity, treeUri)
            ?: throw IllegalStateException("Cannot read the selected folder")

        val jsonFile = root.listFiles()
            .filter { it.isFile && it.name?.endsWith(".json", ignoreCase = true) == true }
            .sortedBy { it.name.orEmpty() }
            .firstOrNull()
            ?: throw IllegalStateException("No .json backup file found at the top level")

        val json = activity.contentResolver.openInputStream(jsonFile.uri)?.use { input ->
            input.bufferedReader(Charsets.UTF_8).readText()
        } ?: throw IllegalStateException("Cannot read ${jsonFile.name}")

        val avatars = JSONArray()
        val avatarFolder = root.findFile("avatars")
        avatarFolder?.listFiles()
            ?.filter { it.isFile && it.name?.endsWith(".vrm", ignoreCase = true) == true }
            ?.sortedBy { it.name.orEmpty() }
            ?.forEach { file ->
                val originalName = file.name ?: "avatar.vrm"
                val destination = copyToPrivate(file.uri, avatarsDir, originalName, ".vrm")
                avatars.put(
                    JSONObject()
                        .put("fileName", originalName)
                        .put("path", destination.absolutePath)
                        .put("dataBase64", encodeBase64(destination)),
                )
            }

        JSONObject()
            .put("json", json)
            .put("avatars", avatars)
    }

    fun onBundleExported(callbackId: String, uri: Uri?, json: String) =
        handleSafResult(callbackId) {
            if (uri == null) throw IllegalStateException("No output file was selected")
            activity.contentResolver.openOutputStream(uri)?.use { output ->
                output.write(json.toByteArray(Charsets.UTF_8))
                output.flush()
            } ?: throw IllegalStateException("Cannot write the selected file")
            JSONObject().put("path", uri.toString())
        }

    private fun handleSafResult(callbackId: String, block: suspend () -> Any) {
        activity.lifecycleScope.launch(Dispatchers.Default) {
            runCatching { block() }
                .onSuccess { postOk(callbackId, it) }
                .onFailure { postError(callbackId, it) }
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        val cursor = activity.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        ) ?: return null
        return cursor.use {
            val index = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && it.moveToFirst()) it.getString(index) else null
        }
    }

    private fun copyToPrivate(uri: Uri, dir: File, displayName: String, extension: String): File {
        if (!dir.exists() && !dir.mkdirs()) {
            throw IllegalStateException("Cannot create ${dir.absolutePath}")
        }
        val destination = uniqueFile(dir, safeFileName(displayName, extension))
        try {
            activity.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destination).use { output ->
                    input.copyTo(output, bufferSize = 64 * 1024)
                }
            } ?: throw IllegalStateException("Cannot open document: $uri")
        } catch (error: Throwable) {
            destination.delete()
            throw error
        }
        return destination
    }

    private fun safeFileName(input: String, extension: String): String {
        var name = input.substringAfterLast('/').substringAfterLast('\\').trim()
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trim('.', '_')
        if (name.isEmpty()) name = "import"
        if (!name.endsWith(extension, ignoreCase = true)) name += extension
        return name
    }

    private fun uniqueFile(dir: File, name: String): File {
        var candidate = File(dir, name)
        var suffix = 1
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        while (candidate.exists()) {
            candidate = File(dir, "$base-$suffix$ext")
            suffix++
        }
        return candidate
    }

    private fun encodeBase64(file: File): String =
        Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)

    // ---------------------------------------------------------------------
    // llama.cpp inference (llama-android 0.1.1)
    // ---------------------------------------------------------------------

    private suspend fun loadModel(args: JSONObject): JSONObject {
        val path = args.optString("path").takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("loadModel requires path")
        loadModelInternal(path, forceReload = true)
        return JSONObject().put("loaded", true).put("path", path)
    }

    private suspend fun loadModelInternal(path: String, forceReload: Boolean): LlamaModel =
        inferenceMutex.withLock {
            val current = loadedModel
            if (!forceReload && current != null && current.isLoaded && loadedPath == path) {
                return@withLock current
            }

            if (current != null) {
                runCatching { Llama.releaseModel(current) }
            }
            loadedModel = null
            loadedPath = null

            val file = File(path)
            if (!file.exists() || !file.isFile) {
                throw IllegalArgumentException("Model file not found: $path")
            }

            // Llama.loadModel(modelPath: String, config: LlamaConfig): suspend LlamaModel
            val model = Llama.loadModel(file.absolutePath, LlamaConfig(2048, 4))
            loadedModel = model
            loadedPath = file.absolutePath
            model
        }

    private suspend fun complete(args: JSONObject, callbackId: String): JSONObject {
        val request = args.getJSONObject("request")
        val requestId = request.optString("requestId").ifBlank { callbackId }
        val job = currentCoroutineContext()[Job]
            ?: throw IllegalStateException("Missing coroutine job")
        activeRequests[requestId] = job

        return try {
            val modelPath = request.optString("model").takeIf { it.isNotBlank() }
                ?: loadedPath
                ?: throw IllegalArgumentException("complete requires request.model")
            val model = loadModelInternal(modelPath, forceReload = false)
            job.ensureActive()

            val (systemPrompt, prompt) = buildPrompt(request)
            val maxTokens = args.optInt("maxTokens", 256).coerceIn(1, 4096)

            // Llama.complete(model, prompt, systemPrompt, maxTokens): suspend LlamaResult
            val result = Llama.complete(model, prompt, systemPrompt, maxTokens)
            job.ensureActive()
            JSONObject().put("text", result.text)
        } finally {
            activeRequests.remove(requestId, job)
        }
    }

    private fun cancel(args: JSONObject): JSONObject {
        val requestId = args.optString("requestId")
        val job = activeRequests[requestId]
        val cancelled = if (job == null || !job.isActive) {
            false
        } else {
            job.cancel(CancellationException("Cancelled by request $requestId"))
            true
        }
        return JSONObject().put("cancelled", cancelled)
    }

    private fun buildPrompt(request: JSONObject): Pair<String, String> {
        val messages = request.optJSONArray("messages") ?: JSONArray()
        val system = StringBuilder()
        val conversation = StringBuilder()
        var lastRole = ""

        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            val role = message.optString("role", "user").ifBlank { "user" }
            val content = message.optString("content", "")
            when (role) {
                "system" -> {
                    if (system.isNotEmpty()) system.append("\n\n")
                    system.append(content)
                }
                "user" -> {
                    conversation.append("User: ").append(content).append('\n')
                    lastRole = role
                }
                "assistant" -> {
                    conversation.append("Assistant: ").append(content).append('\n')
                    lastRole = role
                }
                else -> {
                    conversation.append(role.replaceFirstChar { it.uppercase() })
                        .append(": ")
                        .append(content)
                        .append('\n')
                    lastRole = role
                }
            }
        }

        if (conversation.isNotEmpty() && lastRole != "assistant") {
            conversation.append("Assistant:")
        }
        return system.toString() to conversation.toString().trimEnd()
    }

    // ---------------------------------------------------------------------
    // Text-to-speech
    // ---------------------------------------------------------------------

    private suspend fun speak(text: String): Boolean = withContext(Dispatchers.Main) {
        if (text.isBlank()) return@withContext false

        suspendCancellableCoroutine<Boolean> { continuation ->
            var engine: TextToSpeech? = null
            var finished = false

            fun finish(value: Boolean) {
                if (finished) return
                finished = true
                engine?.shutdown()
                if (continuation.isActive) continuation.resume(value)
            }

            try {
                engine = TextToSpeech(activity) { status ->
                    if (status != TextToSpeech.SUCCESS) {
                        finish(false)
                        return@TextToSpeech
                    }
                    val current = engine ?: run {
                        finish(false)
                        return@TextToSpeech
                    }

                    val languageStatus = current.setLanguage(Locale.getDefault())
                    if (languageStatus == TextToSpeech.LANG_MISSING_DATA ||
                        languageStatus == TextToSpeech.LANG_NOT_SUPPORTED
                    ) {
                        current.setLanguage(Locale.US)
                    }

                    val utteranceId = "virtua-tts-${System.currentTimeMillis()}"
                    current.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) = Unit
                        override fun onDone(utteranceId: String?) = finish(true)
                        override fun onError(utteranceId: String?) = finish(false)
                    })

                    if (current.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) != TextToSpeech.SUCCESS) {
                        finish(false)
                    }
                }
                continuation.invokeOnCancellation { finish(false) }
            } catch (error: Throwable) {
                finish(false)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Callback transport
    // ---------------------------------------------------------------------

    fun onQrScanned(callbackId: String, contents: String?) {
        if (contents.isNullOrBlank()) {
            postError(callbackId, IllegalStateException("QR scan canceled."))
        } else {
            postOk(callbackId, contents)
        }
    }

    private fun postOk(callbackId: String, value: Any) {
        postResult(callbackId, JSONObject().put("ok", true).put("value", value))
    }

    fun postError(callbackId: String, error: Throwable) {
        val message = error.message?.takeIf { it.isNotBlank() }
            ?: error::class.java.simpleName
        postResult(callbackId, JSONObject().put("ok", false).put("error", message))
    }

    private fun postResult(callbackId: String, result: JSONObject) {
        // JSON.parse keeps `jsonResult` a real object on the JS side, and
        // JSONObject.quote safely escapes the caller-supplied callback id.
        val script = "window.__virtuaNativeCallback(" +
            "${JSONObject.quote(callbackId)}, JSON.parse(${JSONObject.quote(result.toString())}));"
        webView.post { webView.evaluateJavascript(script, null) }
    }
}
