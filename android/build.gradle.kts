// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    // AGP 9.1 includes built-in Kotlin support (Kotlin 2.2.10); do not apply
    // org.jetbrains.kotlin.android alongside it.
    id("com.android.application") version "9.1.1" apply false
}
