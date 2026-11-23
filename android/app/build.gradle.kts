plugins {
    // Kotlin is built into AGP 9.1; no separate kotlin-android plugin.
    id("com.android.application")
}

android {
    namespace = "com.virtua.nativeandroid"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.virtua.nativeandroid"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // llama-android 0.1.1 ships arm64-v8a native libraries only.
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // On-device GGUF inference (arm64-v8a, API 24+). Local only; no network calls.
    implementation("dev.ffmpegkit-maintained:llama-android:0.1.1")

    // Local QR scanner for pairing with the desktop bridge. No cloud/ML model downloads.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
