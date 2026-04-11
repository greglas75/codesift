package com.x.ui

import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import androidx.lifecycle.ViewModel

@HiltViewModel
class UserViewModel @Inject constructor(
    private val repo: UserRepository,
    private val logger: Logger,
) : ViewModel() {
    suspend fun loadUser(id: Int) {
        val user = repo.fetchUser(id)
        logger.log("loaded: ${user.name}")
    }
}
