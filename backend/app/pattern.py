"""Pattern guides (second control image) drawn with the pixel editor.

A pattern is a small W×H pixel tile. It is stretched (nearest neighbour, so cells stay
crisp) to fill the output size ``out_w``×``out_h``; empty tile pixels are white. Output
goes to ``<dataset>_pattern`` with the same file name as the image, and the spec is
embedded in the PNG (text chunk) so it can be re-edited and identical tiles can be found.
"""

from __future__ import annotations

import glob
import hashlib
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, PngImagePlugin
from pydantic import BaseModel, field_validator

from .datasets import FLIP_SUFFIX, IMAGE_EXTS, DatasetError, DatasetStore, is_flip_stem

PNG_KEY = "aitk_pattern"
SUFFIX = "_pattern"
BACKGROUND = "#ffffff"  # empty tile pixels
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class PatternSpec(BaseModel):
    w: int
    h: int
    pixels: list[str]  # w*h entries, "#rrggbb" or "" (= white), row-major
    out_w: int  # saved image size (the tile is stretched to fill it)
    out_h: int

    @field_validator("w", "h")
    @classmethod
    def _size(cls, v: int) -> int:
        if not 1 <= v <= 256:
            raise ValueError("캔버스 크기는 1~256 이어야 합니다.")
        return v

    @field_validator("out_w", "out_h")
    @classmethod
    def _out(cls, v: int) -> int:
        if not 1 <= v <= 8192:
            raise ValueError("저장 크기는 1~8192 px 이어야 합니다.")
        return v

    @field_validator("pixels")
    @classmethod
    def _pixels(cls, v: list[str]) -> list[str]:
        for p in v:
            if p and not _HEX.match(p):
                raise ValueError(f"잘못된 색상: {p}")
        # Empty pixels are white, so store them as white (one canonical form per tile).
        return [(p or BACKGROUND).lower() for p in v]

    def model_post_init(self, _ctx) -> None:
        if len(self.pixels) != self.w * self.h:
            raise ValueError("pixels 길이가 w*h 와 다릅니다.")

    def tile_digest(self) -> str:
        """Identity of the drawn tile (output size not included)."""
        raw = json.dumps([self.w, self.h, self.pixels], separators=(",", ":"))
        return hashlib.sha1(raw.encode()).hexdigest()[:16]


def pattern_dataset(name: str) -> str:
    return f"{name}{SUFFIX}"


def _rgb(hex_: str) -> tuple[int, int, int]:
    return (int(hex_[1:3], 16), int(hex_[3:5], 16), int(hex_[5:7], 16))


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).size


def render(spec: PatternSpec) -> Image.Image:
    tile = np.array([_rgb(p) for p in spec.pixels], dtype=np.uint8).reshape(spec.h, spec.w, 3)
    return Image.fromarray(tile, mode="RGB").resize((spec.out_w, spec.out_h), Image.Resampling.NEAREST)


def _save(img: Image.Image, spec: PatternSpec, dst: Path, mirrored: bool) -> None:
    info = PngImagePlugin.PngInfo()
    info.add_text(PNG_KEY, json.dumps({"v": 2, "spec": spec.model_dump(), "mirrored": mirrored}, separators=(",", ":")))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    img.save(tmp, format="PNG", pnginfo=info)
    tmp.replace(dst)


def read_meta(path: Path) -> dict | None:
    try:
        with Image.open(path) as im:
            raw = getattr(im, "text", {}).get(PNG_KEY) or im.info.get(PNG_KEY)
            size = im.size
    except OSError:
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        spec = dict(data["spec"])
        # v1 files (tiled guides) carry no output size: use the PNG's own size.
        spec.setdefault("out_w", size[0])
        spec.setdefault("out_h", size[1])
        return {"spec": PatternSpec(**spec), "mirrored": bool(data.get("mirrored"))}
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
    w, h = image_size(_src(store, dataset, path))
    meta = read_meta(_out_path(store, dataset, path))
    return {
        "width": w,
        "height": h,
        "spec": meta["spec"].model_dump() if meta and not meta["mirrored"] else None,
        "mirrored": bool(meta and meta["mirrored"]),
    }


def save_pattern(store: DatasetStore, dataset: str, path: str, spec: PatternSpec) -> dict:
    ds_dir = store.dataset_dir(dataset)
    src = _src(store, dataset, path)
    img = render(spec)
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
    sizes: dict[tuple[int, int], int] = {}
    if out_dir.is_dir():
        for png in sorted(out_dir.rglob("*.png")):
            if any(part.startswith(".") for part in png.relative_to(out_dir).parts):
                continue
            meta = read_meta(png)
            key = png.relative_to(out_dir).with_suffix("").as_posix()
            if meta is None:
                keys[key] = ""  # a PNG made elsewhere: counts as "has pattern" but can't be reused
                continue
            d = meta["spec"].tile_digest()
            keys[key] = d
            if meta["mirrored"]:
                continue
            u = unique.setdefault(d, {"digest": d, "spec": meta["spec"].model_dump(), "count": 0, "keys": []})
            sizes[(meta["spec"].out_w, meta["spec"].out_h)] = sizes.get((meta["spec"].out_w, meta["spec"].out_h), 0) + 1
            u["count"] += 1
            if len(u["keys"]) < 20:
                u["keys"].append(key)
    return {
        "dataset": pattern_dataset(dataset),
        "exists": out_dir.is_dir(),
        "items": keys,
        "unique": sorted(unique.values(), key=lambda u: -u["count"]),
        # Most used output size, the default for new patterns in this dataset.
        "common_size": list(max(sizes, key=sizes.get)) if sizes else None,
    }
