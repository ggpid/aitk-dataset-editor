"""Procedural pattern guides (second control image) drawn with the pixel editor.

A pattern is a small W×H pixel tile. It is rendered at the size of a dataset image by
repeating the tile over the whole canvas, each tile pixel becoming a ``cell``×``cell``
block. The tile origin is the image's top-left or the top-left of the opaque area's
bounding box (the building), plus an offset. Output goes to ``<dataset>_pattern`` with
the same file name as the image, and the spec is embedded in the PNG (text chunk) so it
can be re-edited and identical patterns can be found.

The JS editor renders previews with the same formula (see ``tile_index``).
"""

from __future__ import annotations

import glob
import hashlib
import json
import re
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageOps, PngImagePlugin
from pydantic import BaseModel, field_validator

from .datasets import DatasetError, DatasetStore, FLIP_SUFFIX, IMAGE_EXTS, is_flip_stem

PNG_KEY = "aitk_pattern"
SUFFIX = "_pattern"
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class PatternSpec(BaseModel):
    w: int
    h: int
    cell: int = 8  # output px per tile pixel
    pixels: list[str]  # w*h entries, "#rrggbb" or "" (transparent), row-major
    anchor: Literal["image", "bbox"] = "image"
    offset_x: int = 0
    offset_y: int = 0
    clip: Literal["none", "opaque"] = "none"  # draw only where the image is opaque
    background: str = ""  # colour under transparent tile pixels ("" = transparent)

    @field_validator("w", "h")
    @classmethod
    def _size(cls, v: int) -> int:
        if not 1 <= v <= 256:
            raise ValueError("캔버스 크기는 1~256 이어야 합니다.")
        return v

    @field_validator("cell")
    @classmethod
    def _cell(cls, v: int) -> int:
        if not 1 <= v <= 512:
            raise ValueError("셀 크기는 1~512 px 이어야 합니다.")
        return v

    @field_validator("pixels")
    @classmethod
    def _pixels(cls, v: list[str]) -> list[str]:
        for p in v:
            if p and not _HEX.match(p):
                raise ValueError(f"잘못된 색상: {p}")
        return [p.lower() for p in v]

    @field_validator("background")
    @classmethod
    def _bg(cls, v: str) -> str:
        if v and not _HEX.match(v):
            raise ValueError(f"잘못된 배경색: {v}")
        return v.lower()

    def model_post_init(self, _ctx) -> None:
        if len(self.pixels) != self.w * self.h:
            raise ValueError("pixels 길이가 w*h 와 다릅니다.")

    def canonical(self) -> str:
        return json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))

    def digest(self) -> str:
        return hashlib.sha1(self.canonical().encode()).hexdigest()[:16]


def pattern_dataset(name: str) -> str:
    return f"{name}{SUFFIX}"


def _rgba(hex_: str) -> tuple[int, int, int, int]:
    if not hex_:
        return (0, 0, 0, 0)
    return (int(hex_[1:3], 16), int(hex_[3:5], 16), int(hex_[5:7], 16), 255)


def image_geometry(path: Path) -> tuple[int, int, tuple[int, int, int, int] | None, np.ndarray]:
    """(width, height, opaque bbox (x0, y0, x1, y1) or None, alpha array) after EXIF rotation."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        alpha = np.asarray(im.convert("RGBA"))[..., 3]
    ys, xs = np.nonzero(alpha > 16)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else None
    return alpha.shape[1], alpha.shape[0], bbox, alpha


def origin(spec: PatternSpec, bbox: tuple[int, int, int, int] | None) -> tuple[int, int]:
    ax, ay = (bbox[0], bbox[1]) if spec.anchor == "bbox" and bbox else (0, 0)
    return ax + spec.offset_x, ay + spec.offset_y


def render(spec: PatternSpec, width: int, height: int, bbox, alpha: np.ndarray | None) -> Image.Image:
    tile = np.array([_rgba(p) for p in spec.pixels], dtype=np.uint8).reshape(spec.h, spec.w, 4)
    if spec.background:
        bg = np.array(_rgba(spec.background), dtype=np.uint8)
        tile[tile[..., 3] == 0] = bg
    ox, oy = origin(spec, bbox)
    # tile_index: floor((x - ox) / cell) mod w  (same in the JS preview)
    cols = np.floor_divide(np.arange(width) - ox, spec.cell) % spec.w
    rows = np.floor_divide(np.arange(height) - oy, spec.cell) % spec.h
    out = tile[rows[:, None], cols[None, :]]
    if spec.clip == "opaque" and alpha is not None:
        out = out.copy()
        out[alpha <= 16] = 0
    return Image.fromarray(out, mode="RGBA")


def _save(img: Image.Image, spec: PatternSpec, dst: Path, mirrored: bool) -> None:
    info = PngImagePlugin.PngInfo()
    info.add_text(PNG_KEY, json.dumps({"spec": spec.model_dump(), "mirrored": mirrored}, separators=(",", ":")))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    img.save(tmp, format="PNG", pnginfo=info)
    tmp.replace(dst)


def read_meta(path: Path) -> dict | None:
    try:
        with Image.open(path) as im:
            raw = getattr(im, "text", {}).get(PNG_KEY) or im.info.get(PNG_KEY)
    except OSError:
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return {"spec": PatternSpec(**data["spec"]), "mirrored": bool(data.get("mirrored"))}
    except (ValueError, KeyError, TypeError):
        return None


# ---- dataset level ----------------------------------------------------------
def _src(store: DatasetStore, dataset: str, path: str) -> Path:
    src = store.item_path(dataset, path)
    if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
        raise DatasetError("이미지를 찾을 수 없습니다.", 404)
    return src


def _out_path(store: DatasetStore, dataset: str, rel: str) -> Path:
    out_dir = store.dataset_dir(pattern_dataset(dataset), must_exist=False)
    return out_dir / Path(rel).with_suffix(".png")


def target_info(store: DatasetStore, dataset: str, path: str) -> dict:
    w, h, bbox, _ = image_geometry(_src(store, dataset, path))
    meta = read_meta(_out_path(store, dataset, path))
    return {
        "width": w,
        "height": h,
        "bbox": list(bbox) if bbox else None,
        "spec": meta["spec"].model_dump() if meta and not meta["mirrored"] else None,
        "mirrored": bool(meta and meta["mirrored"]),
    }


def save_pattern(store: DatasetStore, dataset: str, path: str, spec: PatternSpec) -> dict:
    ds_dir = store.dataset_dir(dataset)
    src = _src(store, dataset, path)
    w, h, bbox, alpha = image_geometry(src)
    img = render(spec, w, h, bbox, alpha)
    written = [path]
    _save(img, spec, _out_path(store, dataset, path), mirrored=False)

    # The _flip copy of an original is its mirror image, so its guide is the mirrored guide.
    if not is_flip_stem(src.stem):
        for flip in sorted(src.parent.glob(f"{glob.escape(src.stem)}{FLIP_SUFFIX}.*")):
            if flip.suffix.lower() in IMAGE_EXTS:
                rel = flip.relative_to(ds_dir).as_posix()
                _save(img.transpose(Image.Transpose.FLIP_LEFT_RIGHT), spec, _out_path(store, dataset, rel), True)
                written.append(rel)
    return {"dataset": pattern_dataset(dataset), "written": written}


def delete_pattern(store: DatasetStore, dataset: str, path: str) -> dict:
    ds_dir = store.dataset_dir(dataset)
    src = store.item_path(dataset, path)
    removed = []
    targets = [path]
    if not is_flip_stem(src.stem):
        targets += [f.relative_to(ds_dir).as_posix() for f in src.parent.glob(f"{glob.escape(src.stem)}{FLIP_SUFFIX}.*")]
    for rel in targets:
        out = _out_path(store, dataset, rel)
        meta = read_meta(out) if out.is_file() else None
        # Only remove the flip's guide if it was generated as a mirror.
        if out.is_file() and (rel == path or (meta and meta["mirrored"])):
            out.unlink()
            removed.append(rel)
    return {"removed": removed}


def list_patterns(store: DatasetStore, dataset: str) -> dict:
    """Which items have a pattern, and the unique patterns (first-use order) with counts."""
    store.dataset_dir(dataset)
    out_dir = store.dataset_dir(pattern_dataset(dataset), must_exist=False)
    keys: dict[str, str] = {}  # item key (rel path without ext) -> digest
    unique: dict[str, dict] = {}
    if out_dir.is_dir():
        for png in sorted(out_dir.rglob("*.png")):
            if any(part.startswith(".") for part in png.relative_to(out_dir).parts):
                continue
            meta = read_meta(png)
            key = png.relative_to(out_dir).with_suffix("").as_posix()
            if meta is None:
                keys[key] = ""  # a PNG made elsewhere: counts as "has pattern" but can't be reused
                continue
            d = meta["spec"].digest()
            keys[key] = d
            if meta["mirrored"]:
                continue
            u = unique.setdefault(d, {"digest": d, "spec": meta["spec"].model_dump(), "count": 0, "keys": []})
            u["count"] += 1
            if len(u["keys"]) < 20:
                u["keys"].append(key)
    return {
        "dataset": pattern_dataset(dataset),
        "exists": out_dir.is_dir(),
        "items": keys,
        "unique": sorted(unique.values(), key=lambda u: -u["count"]),
    }
