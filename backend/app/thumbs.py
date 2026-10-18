"""Disk-cached thumbnails so large datasets stay fast in the browser."""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image, ImageOps

from .config import CACHE_DIR

ALLOWED_SIZES = (128, 256, 384, 512, 768, 1024)


def normalise_size(size: int) -> int:
    for s in ALLOWED_SIZES:
        if size <= s:
            return s
    return ALLOWED_SIZES[-1]


def thumbnail(src: Path, size: int) -> Path:
    size = normalise_size(size)
    stat = src.stat()
    digest = hashlib.sha1(f"{src}|{stat.st_mtime_ns}|{stat.st_size}|{size}".encode()).hexdigest()
    out = CACHE_DIR / "thumbs" / digest[:2] / f"{digest}.webp"
    if out.is_file():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size), Image.Resampling.LANCZOS)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
        tmp = out.with_suffix(".tmp")
        im.save(tmp, format="WEBP", quality=82)
        tmp.replace(out)
    return out
