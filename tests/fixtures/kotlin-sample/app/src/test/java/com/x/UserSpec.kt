package com.x

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class UserSpec : FunSpec({
    test("validates email") {
        val email = "foo@bar.com"
        email shouldBe "foo@bar.com"
    }

    test("rejects empty email") {
        val email = ""
        email.isEmpty() shouldBe true
    }
})
