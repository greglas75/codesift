package com.x.ui

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {
    @Provides
    fun provideUserRepository(): UserRepository {
        return UserRepositoryImpl()
    }

    @Provides
    fun provideLogger(): Logger {
        return ConsoleLogger()
    }
}
