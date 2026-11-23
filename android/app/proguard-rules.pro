# JS bridge: annotations keep the public method, but keep the whole class explicitly.
-keep class com.virtua.nativeandroid.VirtuaBridge { *; }
-keepattributes *Annotation*, JavascriptInterface

# llama-android reflects over its JNI entry points and data classes.
-keep class dev.ffmpegkit.llama.** { *; }
-keep class * extends dev.ffmpegkit.llama.LlamaException { *; }

# org.json is part of the platform; keep its names just in case of R8 shrinking differences.
-keep class org.json.** { *; }
