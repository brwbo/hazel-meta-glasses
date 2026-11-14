from typing import Annotated

from pydantic import BaseModel, Field


class Enrol(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    consent: str = Field(min_length=1, max_length=500)
    role: str = Field(default="", max_length=120)


class PersonPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    role: str | None = Field(default=None, max_length=120)
    summary: str | None = Field(default=None, max_length=2000)
    tags: list[Annotated[str, Field(max_length=40)]] | None = Field(default=None, max_length=12)
    followups: list[Annotated[str, Field(max_length=300)]] | None = Field(default=None, max_length=12)


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
