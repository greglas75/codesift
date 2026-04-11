"""Domain models."""

from dataclasses import dataclass


@dataclass
class User:
    id: int
    name: str
    email: str = ""


@dataclass(frozen=True)
class Post:
    id: int
    title: str
    author_id: int
