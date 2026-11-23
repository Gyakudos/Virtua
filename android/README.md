# Virtua Android companion

Native WebView shell for the local-first Virtua app. All models, avatars and backups stay in
app-private storage; there is no telemetry or cloud dependency.

## Build

```powershell
cd F:\Virtual Assistant\android
.\gradlew.bat assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

`sdk.dir` is set in the (git-ignored) `local.properties` to `F:\dev\android-sdk`.

## Web assets

The Vite mobile build must be copied to:

```
app/src/main/assets/public/index.html
```

`MainActivity` loads `file:///android_asset/public/index.html`. Web assets are intentionally not
included here.

## JavaScript bridge

`window.VirtuaNative.call(method, argsJson, callbackId)` dispatches asynchronously and calls:

```js
window.__virtuaNativeCallback(callbackId, { ok: true, value: ... })
// or
window.__virtuaNativeCallback(callbackId, { ok: false, error: "..." })
```

Supported methods: `models`, `pickModel`, `loadModel`, `complete`, `cancel`, `pickVrm`, `speak`,
`importBundleFromSaf`, `exportBundleToSaf`.

Private storage:

- GGUF models: `filesDir/models`
- Imported/picked VRM avatars: `filesDir/avatars`

`importBundleFromSaf` returns each avatar as
`{ fileName, path, dataBase64 }` where `path` is the app-private file path.

## Toolchain notes

- AGP 9.1.1 (built-in Kotlin 2.2.10 — no separate `kotlin-android` plugin)
- Gradle wrapper 9.3.1
- compileSdk/targetSdk 36, minSdk 24, Java 17 bytecode
- `dev.ffmpegkit-maintained:llama-android:0.1.1` ships arm64-v8a libraries only, so the APK
  filters to `arm64-v8a` (no x86 emulator support).
