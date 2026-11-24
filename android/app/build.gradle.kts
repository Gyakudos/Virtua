import java.util.Properties

plugins {
    // Kotlin is built into AGP 9.1; no separate kotlin-android plugin.
    id("com.android.application")
}

val signingProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val releaseStoreFile = signingProperties.getProperty("virtua.keystore.file")?.let { rootProject.file(it) }
val releaseStorePassword = signingProperties.getProperty("virtua.keystore.storePassword")
val releaseKeyAlias = signingProperties.getProperty("virtua.keystore.keyAlias")
val releaseKeyPassword = signingProperties.getProperty("virtua.keystore.keyPassword")
val hasReleaseSigning = releaseStoreFile != null && releaseStoreFile.exists() &&
    !releaseStorePassword.isNullOrBlank() && !releaseKeyAlias.isNullOrBlank() &&
    !releaseKeyPassword.isNullOrBlank()

android {
    namespace = "com.virtua.nativeandroid"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.virtua.nativeandroid"
        minSdk = 24
        targetSdk = 36
        versionCode = 15005
        versionName = "000.015.005.2026"

        ndk {
            // llama-android 0.1.1 ships arm64-v8a native libraries only.
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Release signing credentials live in gitignored android/local.properties.
    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = releaseStoreFile!!
                storePassword = releaseStorePassword!!
                keyAlias = releaseKeyAlias!!
                keyPassword = releaseKeyPassword!!
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
            // Keep R8 off: the WebView JS bridge and llama-android rely on reflection/JNI names.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
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
