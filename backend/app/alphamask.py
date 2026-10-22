"""Mask dataset from transparency: opaque pixels (alpha > threshold) are white, the rest
black. Masks are PNGs named like the source images (sub folders kept), for ai-toolkit's
``mask_path``. Optionally also writes side-by-side preview images like the wall masks.
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from .datasets import DatasetError, DatasetStore, Item, clean_rename_name
from .progress import NO_PROGRESS, Progress
from .wallmask import MASK_EXTS, load_rgba, morph, preview_image


def opaque_mask(path: Path, threshold: int, grow_px: int) -> tuple[np.ndarray, np.ndarray, bool]:
    """Return (mask, rgba, had_alpha). ``grow_px`` > 0 dilates, < 0 erodes the opaque area."""
    with Image.open(path) as im:
        had_alpha = im.mode in ("RGBA", "LA", "PA", "La", "RGBa") or "transparency" in im.info
    rgba = load_rgba(path)
    mask = Image.fromarray(((rgba[..., 3] > threshold) * 255).astype(np.uint8), mode="L")
    if grow_px > 0:
        mask = morph(mask, "dilate", grow_px)
    elif grow_px < 0:
        mask = morph(mask, "erode", -grow_px)
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


def preview_png(store: DatasetStore, dataset: str, path: str, threshold: int, grow_px: int) -> tuple[bytes, dict]:
    src = store.item_path(dataset, path)
    if not src.is_file() or src.suffix.lower() not in MASK_EXTS:
        raise DatasetError("이미지를 찾을 수 없습니다.", 404)
    mask, rgba, had_alpha = opaque_mask(src, threshold, grow_px)
    img = preview_image(mask, rgba)
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
    progress: Progress = NO_PROGRESS,
) -> dict:
    src_dir = store.dataset_dir(dataset)
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
            mask, rgba, had_alpha = opaque_mask(src_dir / it.path, threshold, grow_px)
            rel = Path(it.path).with_suffix(".png")
            (tmp_out / rel).parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(mask, mode="L").save(tmp_out / rel)
            if tmp_prev is not None:
                (tmp_prev / rel).parent.mkdir(parents=True, exist_ok=True)
                preview_image(mask, rgba).save(tmp_prev / rel)
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
        "no_alpha": no_alpha,  # no transparency -> fully white mask
        "empty": empty,  # fully transparent -> fully black mask
    }
