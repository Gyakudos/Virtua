package com.virtua.nativeandroid

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Hosts the Vite-built web app from file:///android_asset/public/index.html and
 * exposes the `VirtuaNative` JavaScript bridge.
 */
class MainActivity : ComponentActivity() {

    private val webView: WebView by lazy { createWebView() }
    private val bridge: VirtuaBridge by lazy { VirtuaBridge(this, webView) }

    // SAF launches are asynchronous; keep the originating JS callback id for each request.
    private val pendingModelIds = ArrayDeque<String>()
    private val pendingVrmIds = ArrayDeque<String>()
    private val pendingImportIds = ArrayDeque<String>()
    private val pendingExportIds = ArrayDeque<String>()
    private val exportPayloads = HashMap<String, String>()

    private val pickModelLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callbackId = pendingModelIds.removeFirstOrNull() ?: return@registerForActivityResult
            bridge.onModelPicked(callbackId, result.data?.data)
        }

    private val pickVrmLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callbackId = pendingVrmIds.removeFirstOrNull() ?: return@registerForActivityResult
            bridge.onVrmPicked(callbackId, result.data?.data)
        }

    private val importBundleLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callbackId = pendingImportIds.removeFirstOrNull() ?: return@registerForActivityResult
            bridge.onBundleImported(callbackId, result.data?.data)
        }

    private val exportBundleLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callbackId = pendingExportIds.removeFirstOrNull() ?: return@registerForActivityResult
            val json = exportPayloads.remove(callbackId).orEmpty()
            bridge.onBundleExported(callbackId, result.data?.data, json)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(webView)
        webView.addJavascriptInterface(bridge, "VirtuaNative")
        webView.loadUrl("file:///android_asset/public/index.html")

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    private fun createWebView(): WebView = WebView(this).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setBackgroundColor(Color.TRANSPARENT)

        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            // Required so file:// assets can load other local assets and call the bridge.
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            // file:// assets open opt-in ws:// bridges on the LAN/Tailscale.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadsImagesAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        }

        webViewClient = WebViewClient()
        webChromeClient = WebChromeClient()
        WebView.setWebContentsDebuggingEnabled(
            applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )
    }

    private fun documentPickerIntent(extensions: Array<String>, title: String): Intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // SAF filters are advisory; */* keeps files with unusual extensions selectable.
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, extensions)
            putExtra(Intent.EXTRA_TITLE, title)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }

    fun launchPickModel(callbackId: String) {
        launchDocument(
            callbackId = callbackId,
            queue = pendingModelIds,
            launcher = pickModelLauncher,
            intent = documentPickerIntent(
                arrayOf("application/octet-stream", "application/x-gguf", "*/*"),
                "Select a .gguf model",
            ),
        )
    }

    fun launchPickVrm(callbackId: String) {
        launchDocument(
            callbackId = callbackId,
            queue = pendingVrmIds,
            launcher = pickVrmLauncher,
            intent = documentPickerIntent(
                arrayOf("model/vrm", "application/octet-stream", "*/*"),
                "Select a .vrm avatar",
            ),
        )
    }

    fun launchImportBundle(callbackId: String) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            )
        }
        launchDocument(callbackId, pendingImportIds, importBundleLauncher, intent)
    }

    fun launchExport(callbackId: String, json: String) {
        exportPayloads[callbackId] = json
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, "virtua-backup.json")
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        launchDocument(callbackId, pendingExportIds, exportBundleLauncher, intent)
    }

    private fun launchDocument(
        callbackId: String,
        queue: ArrayDeque<String>,
        launcher: ActivityResultLauncher<Intent>,
        intent: Intent,
    ) {
        queue.addLast(callbackId)
        runCatching { launcher.launch(intent) }.onFailure { error ->
            queue.remove(callbackId)
            exportPayloads.remove(callbackId)
            bridge.postError(callbackId, error)
        }
    }
}
