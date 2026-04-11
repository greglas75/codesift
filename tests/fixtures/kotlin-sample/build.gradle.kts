plugins {
    kotlin("multiplatform") version "1.9.0"
    id("com.android.application")
}

android {
    namespace = "com.example.kmpsample"
    compileSdk = 34
}

dependencies {
    implementation("com.google.dagger:hilt-android:2.48")
    implementation("androidx.compose.ui:ui:1.5.0")
    implementation("io.kotest:kotest-runner-junit5:5.8.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
