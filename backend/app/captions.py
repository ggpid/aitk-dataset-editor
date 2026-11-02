"""Batch caption editing for many items at once."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel

from .datasets import DatasetError, DatasetStore, caption_path

Mode = Literal["set", "prepend", "append", "replace", "clear"]


class CaptionOp(BaseModel):
    mode: Mode
    text: str = ""  # set / prepend / append
    separator: str = ", "  # prepend / append, between the text and the existing caption
    skip_if_contains: bool = True  # prepend / append: leave captions that already contain the text
    only_empty: bool = False  # set: only items without a caption
    find: str = ""  # replace
    replace_with: str = ""  # replace
    ignore_case: bool = False  # replace


def transform(old: str | None, op: CaptionOp) -> str | None:
    """New caption for ``old`` (None = no caption file). Returns ``old`` when unchanged."""
    cur = old or ""
    text = op.text.strip()
    if op.mode == "set":
        if op.only_empty and cur.strip():
            return old
        return op.text
    if op.mode in ("prepend", "append"):
        if not text:
            return old
        if op.skip_if_contains and text.lower() in cur.lower():
            return old
        body = cur.strip()
        if not body:
            return text
        return f"{text}{op.separator}{body}" if op.mode == "prepend" else f"{body}{op.separator}{text}"
    if op.mode == "replace":
        if not op.find or old is None:
            return old
        flags = re.IGNORECASE if op.ignore_case else 0
        return re.sub(re.escape(op.find), lambda _: op.replace_with, old, flags=flags)
    if op.mode == "clear":
        return "" if old is not None else old
    raise DatasetError(f"알 수 없는 작업: {op.mode}")


def _targets(store: DatasetStore, dataset: str, paths: list[str], include_linked: bool) -> list[str]:
    rels = [p for p in dict.fromkeys(paths) if store.item_path(dataset, p).is_file()]
    return rels + (store._linked(dataset, rels) if include_linked else [])


def plan(store: DatasetStore, dataset: str, paths: list[str], op: CaptionOp, include_linked: bool = True) -> dict:
    if op.mode in ("prepend", "append") and not op.text.strip():
        raise DatasetError("추가할 텍스트를 입력하세요.")
    if op.mode == "replace" and not op.find:
        raise DatasetError("찾을 텍스트를 입력하세요.")
    ds = store.dataset_dir(dataset)
    changes = []
    targets = _targets(store, dataset, paths, include_linked)
    for rel in targets:
        cap = caption_path(ds / rel)
        old = cap.read_text(encoding="utf-8", errors="replace") if cap.is_file() else None
        new = transform(old, op)
        if new is not None and new != old:
            changes.append({"path": rel, "before": old, "after": new})
    return {"targets": len(targets), "changed": len(changes), "changes": changes}


def apply(store: DatasetStore, dataset: str, paths: list[str], op: CaptionOp, include_linked: bool = True) -> dict:
    p = plan(store, dataset, paths, op, include_linked)
    ds = store.dataset_dir(dataset)
    for c in p["changes"]:
        caption_path(ds / c["path"]).write_text(c["after"], encoding="utf-8")
    return {"targets": p["targets"], "changed": p["changed"]}
