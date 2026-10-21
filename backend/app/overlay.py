"""Bake the compare view's "겹치기" (B over A at an opacity) into a new dataset.

The result matches what the browser shows in the overlay grid / viewer:
A is the base, B is drawn on top with ``opacity`` (B's own alpha is kept), and B
is either stretched to A's size ("B를 A 크기에 맞춤") or fitted inside A's box,
centred (CSS ``object-fit: contain``). EXIF orientation is applied like browsers do.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps

from .datasets import (
    CAPTION_EXT,
    DatasetError,
    DatasetStore,
    caption_path,
    clean_rename_name,
    compare,
)
from .progress import NO_PROGRESS, Progress

CaptionSource = Literal["a", "b", "none"]

# Pillow can write these back in the same format; anything else is saved as PNG.
_SAVE_FORMATS = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP", ".bmp": "BMP", ".tif": "TIFF", ".tiff": "TIFF"}


def _load(path: Path) -> Image.Image:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        return im.convert("RGBA")


def blend(a_path: Path, b_path: Path, opacity: float, stretch: bool) -> tuple[Image.Image, bool]:
    """Return (composited image, whether A had transparency)."""
    with Image.open(a_path) as raw:
        a_has_alpha = raw.mode in ("RGBA", "LA", "PA") or (raw.mode == "P" and "transparency" in raw.info)
    a = _load(a_path)
    b = _load(b_path)
    if stretch:
        if b.size != a.size:
            b = b.resize(a.size, Image.Resampling.LANCZOS)
        layer = b
    else:
        scale = min(a.width / b.width, a.height / b.height)
        size = (max(1, round(b.width * scale)), max(1, round(b.height * scale)))
        if size != b.size:
            b = b.resize(size, Image.Resampling.LANCZOS)
        layer = Image.new("RGBA", a.size, (0, 0, 0, 0))
        layer.paste(b, ((a.width - b.width) // 2, (a.height - b.height) // 2))
    op = max(0.0, min(1.0, opacity))
    if op < 1:
        layer.putalpha(layer.getchannel("A").point(lambda v: round(v * op)))
    return Image.alpha_composite(a, layer), a_has_alpha


def _save(img: Image.Image, dst: Path, keep_alpha: bool) -> Path:
    fmt = _SAVE_FORMATS.get(dst.suffix.lower())
    if fmt is None:
        dst, fmt = dst.with_suffix(".png"), "PNG"
    if fmt in ("JPEG", "BMP") or not keep_alpha:
        img = img.convert("RGB")
    kwargs: dict = {}
    if fmt == "JPEG":
        kwargs = {"quality": 95, "subsampling": 0}
    elif fmt == "WEBP":
        kwargs = {"quality": 95}
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, format=fmt, **kwargs)
    return dst


def save_overlay_dataset(
    store: DatasetStore,
    a: str,
    b: str,
    new_name: str,
    opacity: float,
    stretch: bool,
    captions: CaptionSource = "a",
    keys: list[str] | None = None,
    ignore_case: bool = False,
    ignore_folders: bool = False,
    progress: Progress = NO_PROGRESS,
) -> dict:
    a_dir, b_dir = store.dataset_dir(a), store.dataset_dir(b)
    cleaned = clean_rename_name(new_name)
    dst = store.dataset_dir(cleaned, must_exist=False)
    if dst.exists():
        raise DatasetError(f"이미 존재하는 데이터셋입니다: {cleaned}", 409)

    pairs = compare(store.list_items(a), store.list_items(b), ignore_case, ignore_folders)["paired"]
    if keys is not None:
        wanted = set(keys)
        pairs = [p for p in pairs if p["key"] in wanted]
    images = [p for p in pairs if p["a"]["kind"] == "image" and p["b"]["kind"] == "image"]
    skipped = len(pairs) - len(images)
    if not images:
        raise DatasetError("저장할 이미지 짝이 없습니다.")
    progress.set_total(len(images))

    tmp = store.root / f".{cleaned}.overlay"
    if tmp.exists():
        shutil.rmtree(tmp)
    written = 0
    try:
        tmp.mkdir()
        for p in images:
            progress.step(p["key"])
            a_src, b_src = a_dir / p["a"]["path"], b_dir / p["b"]["path"]
            img, a_alpha = blend(a_src, b_src, opacity, stretch)
            out = _save(img, tmp / p["a"]["path"], keep_alpha=a_alpha)
            cap_src = {"a": a_src, "b": b_src}.get(captions)
            if cap_src is not None and caption_path(cap_src).is_file():
                shutil.copyfile(caption_path(cap_src), out.with_suffix(CAPTION_EXT))
            written += 1
        tmp.rename(dst)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"name": cleaned, "written": written, "skipped_non_image": skipped}
