package com.example.kmpsample

/**
 * Platform-specific identifier used by the KMP shared module.
 */
expect class Platform() {
    val name: String
}

expect fun getPlatformInfo(): String
