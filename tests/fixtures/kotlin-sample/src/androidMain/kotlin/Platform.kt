package com.example.kmpsample

actual class Platform actual constructor() {
    actual val name: String = "Android"
}

actual fun getPlatformInfo(): String = "Android platform"
