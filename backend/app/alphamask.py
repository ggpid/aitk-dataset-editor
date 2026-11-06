"""Mask dataset from transparency: opaque pixels (alpha > threshold) get one colour (white
by default), the rest another (black by default); either colour may be (semi-)transparent.
Masks are PNGs named like the source images (sub folders kept), for ai-toolkit's
``mask_path``. Optionally also writes side-by-side preview images.
"""

from __future__ import annotations

import io
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from .datasets import DatasetError, DatasetStore, Item, clean_rename_name
from .progress import NO_PROGRESS, Progress
from .wallmask import MASK_EXTS, load_rgba, morph

WHITE = "#ffffffff"
BLACK = "#000000ff"
_HEX = re.compile(r"^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$")


def parse_rgba(value: str) -> tuple[int, int, int, int]:
    """'#rrggbb' or '#rrggbbaa' -> (r, g, b, a)."""
    m = _HEX.match(value.strip())
    if not m:
        raise DatasetError(f"잘못된 색상: {value!r} (#rrggbb 또는 #rrggbbaa)")
    rgb, a = m.group(1), m.group(2) or "ff"
    return int(rgb[0:2], 16), int(rgb[2:4], 16), int(rgb[4:6], 16), int(a, 16)


def colorize(mask: np.ndarray, opaque: tuple, transparent: tuple) -> Image.Image:
    """Paint the binary mask. Grayscale ('L') when both colours are opaque grays (the
    classic white/black mask), RGB when both are opaque, otherwise RGBA."""
    on = mask > 127
    if opaque[3] == 255 and transparent[3] == 255:
        if opaque[0] == opaque[1] == opaque[2] and transparent[0] == transparent[1] == transparent[2]:
            return Image.fromarray(np.where(on, opaque[0], transparent[0]).astype(np.uint8), mode="L")
        out = np.where(on[..., None], np.array(opaque[:3], np.uint8), np.array(transparent[:3], np.uint8))
        return Image.fromarray(out.astype(np.uint8), mode="RGB")
    out = np.where(on[..., None], np.array(opaque, np.uint8), np.array(transparent, np.uint8))
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def _checker(h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // 32) + (xx // 32)) % 2 * 40 + 200).astype(np.float32)
    return np.stack([c] * 3, axis=-1)


def preview_image(mask_img: Image.Image, rgba: np.ndarray) -> Image.Image:
    """Source (left) and the mask exactly as saved (right), both over a checkerboard."""
    h, w = rgba.shape[:2]
    bg = _checker(h, w)

    def over(arr: np.ndarray) -> np.ndarray:
        a = arr[..., 3:4].astype(np.float32) / 255
        return arr[..., :3].astype(np.float32) * a + bg * (1 - a)

    left = over(rgba.astype(np.float32))
    right = over(np.asarray(mask_img.convert("RGBA")).astype(np.float32))
    return Image.fromarray(np.concatenate([left, right], axis=1).clip(0, 255).astype(np.uint8))


EDGE_POSITIONS = ("inside", "center", "outside")


def edge_band(mask: Image.Image, width: int, position: str) -> Image.Image:
    """Only the boundary of the opaque area, ``width`` px thick: inside the area, centred
    on its boundary, or outside it (a ring around the object)."""
    if position not in EDGE_POSITIONS:
        raise DatasetError(f"알 수 없는 경계선 위치: {position}")
    if position == "inside":
        outer, inner = mask, morph(mask, "erode", width)
    elif position == "outside":
        outer, inner = morph(mask, "dilate", width), mask
    else:
        outer, inner = morph(mask, "dilate", width // 2), morph(mask, "erode", width - width // 2)
    band = (np.asarray(outer) > 127) & ~(np.asarray(inner) > 127)
    return Image.fromarray((band * 255).astype(np.uint8), mode="L")


def opaque_mask(
    path: Path, threshold: int, grow_px: int, edge_px: int = 0, edge_pos: str = "inside"
) -> tuple[np.ndarray, np.ndarray, bool]:
    """Return (mask, rgba, had_alpha). ``grow_px`` > 0 dilates, < 0 erodes the opaque area.
    With ``edge_px`` > 0 only its boundary band is kept (see ``edge_band``)."""
    with Image.open(path) as im:
        had_alpha = im.mode in ("RGBA", "LA", "PA", "La", "RGBa") or "transparency" in im.info
    rgba = load_rgba(path)
    mask = Image.fromarray(((rgba[..., 3] > threshold) * 255).astype(np.uint8), mode="L")
    if grow_px > 0:
        mask = morph(mask, "dilate", grow_px)
    elif grow_px < 0:
        mask = morph(mask, "erode", -grow_px)
    if edge_px > 0:
        mask = edge_band(mask, edge_px, edge_pos)
    return np.asarray(mask), rgba, had_alpha


def _images(store: DatasetStore, dataset: str, include_flips: bool) -> list[Item]:
    return [
        it for it in store.list_items(dataset)
        if it.ext in MASK_EXTS and (include_flips or not it.is_flip)
    ]


def info(store: DatasetStore, dataset: str) -> dict:
    items = [it for it in store.list_items(dataset) if it.ext in MASK_EXTS]
    return {
        "images": len(items),
        "flips": sum(it.is_flip for it in items),
        "sample_paths": [it.path for it in items if not it.is_flip][:500] or [it.path for it in items][:500],
    }


def preview_png(
    store: DatasetStore, dataset: str, path: str, threshold: int, grow_px: int,
    opaque_color: str = WHITE, transparent_color: str = BLACK, edge_px: int = 0, edge_pos: str = "inside",
) -> tuple[bytes, dict]:
    src = store.item_path(dataset, path)
    if not src.is_file() or src.suffix.lower() not in MASK_EXTS:
        raise DatasetError("이미지를 찾을 수 없습니다.", 404)
    on_c, off_c = parse_rgba(opaque_color), parse_rgba(transparent_color)
    mask, rgba, had_alpha = opaque_mask(src, threshold, grow_px, edge_px, edge_pos)
    img = preview_image(colorize(mask, on_c, off_c), rgba)
    img.thumbnail((1600, 800), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    cover = float((mask > 127).mean()) * 100
    return buf.getvalue(), {"cover": round(cover, 1), "had_alpha": had_alpha}


def make_alpha_mask_dataset(
    store: DatasetStore,
    dataset: str,
    out_name: str,
    preview_name: str | None,
    threshold: int = 16,
    grow_px: int = 0,
    include_flips: bool = True,
    opaque_color: str = WHITE,
    transparent_color: str = BLACK,
    edge_px: int = 0,
    edge_pos: str = "inside",
    progress: Progress = NO_PROGRESS,
) -> dict:
    src_dir = store.dataset_dir(dataset)
    on_c, off_c = parse_rgba(opaque_color), parse_rgba(transparent_color)
    out_clean = clean_rename_name(out_name)
    prev_clean = clean_rename_name(preview_name) if preview_name else None
    if prev_clean == out_clean:
        raise DatasetError("마스크와 미리보기 데이터셋 이름이 같습니다.")
    for n in filter(None, [out_clean, prev_clean]):
        if store.dataset_dir(n, must_exist=False).exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {n}", 409)

    items = _images(store, dataset, include_flips)
    if not items:
        raise DatasetError(f"데이터셋에 이미지가 없습니다: {dataset}")
    progress.set_total(len(items))

    tmp_out = store.root / f".{out_clean}.alphamask"
    tmp_prev = store.root / f".{prev_clean}.alphamask" if prev_clean else None
    no_alpha: list[str] = []
    empty: list[str] = []
    try:
        for d in filter(None, [tmp_out, tmp_prev]):
            if d.exists():
                shutil.rmtree(d)
            d.mkdir()
        for it in items:
            progress.step(it.path)
            mask, rgba, had_alpha = opaque_mask(src_dir / it.path, threshold, grow_px, edge_px, edge_pos)
            rel = Path(it.path).with_suffix(".png")
            (tmp_out / rel).parent.mkdir(parents=True, exist_ok=True)
            out_img = colorize(mask, on_c, off_c)
            out_img.save(tmp_out / rel)
            if tmp_prev is not None:
                (tmp_prev / rel).parent.mkdir(parents=True, exist_ok=True)
                preview_image(out_img, rgba).save(tmp_prev / rel)
            if not had_alpha:
                no_alpha.append(it.path)
            elif not mask.any():
                empty.append(it.path)
        tmp_out.rename(store.root / out_clean)
        if tmp_prev is not None:
            tmp_prev.rename(store.root / prev_clean)
    except BaseException:
        for d in filter(None, [tmp_out, tmp_prev]):
            shutil.rmtree(d, ignore_errors=True)
        raise
    return {
        "name": out_clean,
        "preview": prev_clean,
        "made": len(items),
        "no_alpha": no_alpha,  # no transparency -> whole mask in the opaque colour
        "empty": empty,  # fully transparent -> whole mask in the transparent colour
    }
