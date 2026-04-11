"""HTTP views."""

import os

from .models import User, Post
from .utils.helpers import format_name

API_URL = "https://example.com/api"


async def get_user(user_id: int) -> User:
    return User(id=user_id, name="alice")


def render_post(post: Post) -> str:
    return format_name(post.title)
