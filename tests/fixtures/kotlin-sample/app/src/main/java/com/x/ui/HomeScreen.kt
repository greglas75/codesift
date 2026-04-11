package com.x.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun HomeScreen(viewModel: UserViewModel) {
    // Render user list here
}

@Preview
@Composable
fun HomeScreenPreview() {
    HomeScreen(viewModel = UserViewModel(FakeRepo(), FakeLogger()))
}
