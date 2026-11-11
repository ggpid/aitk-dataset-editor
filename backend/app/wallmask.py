"""Wall-mask generator for ai-toolkit training (port of make_wall_masks.py).

Compares a *control* image (white building) with a *target* image (building with the
wall painted). Pixels whose colour changed are the wall: white (wall) / black (rest)
mask PNGs are written with the target's file name. Optionally also writes preview
images (target on the left, target + magenta mask on the right).
"""

from __future__ import annotations

import io
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageFilter

from .datasets import DatasetError, DatasetStore, Item, clean_rename_name, pair_key
from .progress import NO_PROGRESS, Progress

MASK_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass
class MaskParams:
    diff_threshold: int = 40  # RGB channel difference above this = painted (0..255)
    alpha_threshold: int = 16  # alpha above this = opaque
    open_px: int = 1  # speck removal radius (0 = off)
    close_px: int = 4  # gap filling radius between stripes (0 = off)
    dilate_px: int = 8  # wall edge margin
    no_control: Literal["alpha", "skip"] = "alpha"  # target without control: whole building / skip


def load_rgba(path: Path, size: tuple[int, int] | None = None) -> np.ndarray:
    with Image.open(path) as im:
        img = im.convert("RGBA")
    if size is not None and img.size != size:
        img = img.resize(size, Image.Resampling.LANCZOS)
    return np.asarray(img).astype(np.int16)


def morph(mask_img: Image.Image, op: str, px: int) -> Image.Image:
    """Dilate (max) / erode (min) with a square of radius ``px``."""
    if px <= 0:
        return mask_img
    size = px * 2 + 1
    f = ImageFilter.MaxFilter(size) if op == "dilate" else ImageFilter.MinFilter(size)
    return mask_img.filter(f)


def make_mask(target: Path, control: Path, p: MaskParams) -> tuple[np.ndarray, np.ndarray, bool]:
    tgt = load_rgba(target)
    h, w = tgt.shape[:2]
    with Image.open(control) as c:
        resized = c.size != (w, h)
    ctl = load_rgba(control, size=(w, h))

    tgt_alpha = tgt[..., 3] > p.alpha_threshold
    diff = np.abs(tgt[..., :3] - ctl[..., :3]).max(axis=-1)
    # Where the control is transparent its RGB means nothing, so that is never "changed".
    ctl_alpha = ctl[..., 3] > p.alpha_threshold
    changed = (diff > p.diff_threshold) & tgt_alpha & ctl_alpha

    m = Image.fromarray((changed * 255).astype(np.uint8), mode="L")
    # open (remove specks) -> close (fill gaps between stripes) -> dilate (edge margin)
    if p.open_px > 0:
        m = morph(morph(m, "erode", p.open_px), "dilate", p.open_px)
    if p.close_px > 0:
        m = morph(morph(m, "dilate", p.close_px), "erode", p.close_px)
    m = morph(m, "dilate", p.dilate_px)

    arr = np.asarray(m).copy()
    arr[~tgt_alpha] = 0  # background stays out even after dilation
    return arr, tgt, resized


def alpha_mask(target: Path, p: MaskParams) -> tuple[np.ndarray, np.ndarray]:
    tgt = load_rgba(target)
    return ((tgt[..., 3] > p.alpha_threshold) * 255).astype(np.uint8), tgt


OVERLAY_COLOR = (255, 0, 255)  # magenta
OVERLAY_OPACITY = 0.55


def check_output_names(store: DatasetStore, names: list[str | None]) -> None:
    """New output datasets must be distinct and not exist yet."""
    given = [n for n in names if n]
    if len(set(given)) != len(given):
        raise DatasetError("마스크와 미리보기 데이터셋 이름이 같습니다.")
    for n in given:
        if store.dataset_dir(n, must_exist=False).exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {n}", 409)


def tint(mask: np.ndarray, tgt: np.ndarray, color=OVERLAY_COLOR, opacity: float = OVERLAY_OPACITY) -> np.ndarray:
    """RGBA float array: the target with the mask's white area tinted with ``color``."""
    out = tgt.astype(np.float32).copy()
    sel = mask > 127
    op = max(0.0, min(1.0, opacity))
    out[sel, :3] = out[sel, :3] * (1 - op) + np.array(color, np.float32) * op
    return out


def overlay_image(mask: np.ndarray, tgt: np.ndarray, color=OVERLAY_COLOR, opacity: float = OVERLAY_OPACITY) -> Image.Image:
    """The target with the wall area tinted (its own transparency kept), for saving."""
    out = tint(mask, tgt, color, opacity).clip(0, 255).astype(np.uint8)
    if out[..., 3].min() == 255:
        return Image.fromarray(out[..., :3], mode="RGB")
    return Image.fromarray(out, mode="RGBA")


def _on_checker(arr: np.ndarray) -> Image.Image:
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    bg = np.stack([(((yy // 32) + (xx // 32)) % 2 * 40 + 200).astype(np.float32)] * 3, axis=-1)
    a = arr[..., 3:4].astype(np.float32) / 255
    return Image.fromarray((arr[..., :3] * a + bg * (1 - a)).clip(0, 255).astype(np.uint8))


def preview_image(mask: np.ndarray, tgt: np.ndarray, color=OVERLAY_COLOR, opacity: float = OVERLAY_OPACITY) -> Image.Image:
    """Target on a checkerboard (left) and with the mask tinted (right)."""
    h, w = mask.shape
    yy, xx = np.mgrid[0:h, 0:w]
    checker = (((yy // 32) + (xx // 32)) % 2 * 40 + 200).astype(np.float32)
    bg = np.stack([checker] * 3, axis=-1)

    def over(arr: np.ndarray) -> np.ndarray:
        a = arr[..., 3:4] / 255
        return arr[..., :3] * a + bg * (1 - a)

    side = np.concatenate([over(tgt.astype(np.float32)), over(tint(mask, tgt, color, opacity))], axis=1)
    return Image.fromarray(side.clip(0, 255).astype(np.uint8))


# ---- dataset-level ------------------------------------------------------------
def _index(items: list[Item], ignore_case: bool, ignore_folders: bool) -> dict[str, Item]:
    out: dict[str, Item] = {}
    for it in items:
        if it.ext in MASK_EXTS:
            out.setdefault(pair_key(it, ignore_case, ignore_folders), it)
    return out


def match(
    store: DatasetStore, target: str, control: str, ignore_case: bool = False, ignore_folders: bool = False
) -> dict:
    """Pair target and control images by name (``_flip`` files included, so flipped
    targets get their own masks when the control has matching flips)."""
    t = _index(store.list_items(target), ignore_case, ignore_folders)
    c = _index(store.list_items(control), ignore_case, ignore_folders)
    keys = sorted(t, key=str.lower)
    return {
        "targets": t,
        "controls": c,
        "keys": keys,
        "only_target": [k for k in keys if k not in c],
        "only_control": sorted((k for k in c if k not in t), key=str.lower),
    }


def preview_png(
    store: DatasetStore, target: str, control: str, key: str, p: MaskParams,
    ignore_case: bool = False, ignore_folders: bool = False,
    overlay_color=OVERLAY_COLOR, overlay_opacity: float = OVERLAY_OPACITY, overlay_only: bool = False,
) -> tuple[bytes, dict]:
    m = match(store, target, control, ignore_case, ignore_folders)
    if key not in m["targets"]:
        raise DatasetError(f"타깃에 없는 이미지입니다: {key}", 404)
    t_path = store.dataset_dir(target) / m["targets"][key].path
    if key in m["controls"]:
        mask, tgt, resized = make_mask(t_path, store.dataset_dir(control) / m["controls"][key].path, p)
    else:
        (mask, tgt), resized = alpha_mask(t_path, p), False
    building = int((tgt[..., 3] > p.alpha_threshold).sum())
    cover = float((mask > 127).sum()) / max(building, 1) * 100
    if overlay_only:
        # Overlay mode: the saved image is the tinted target — show just that.
        img = _on_checker(tint(mask, tgt, overlay_color, overlay_opacity))
    else:
        img = preview_image(mask, tgt, overlay_color, overlay_opacity)
    img.thumbnail((1600, 800), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), {"cover": round(cover, 1), "resized": resized, "has_control": key in m["controls"]}


def make_mask_dataset(
    store: DatasetStore,
    target: str,
    control: str,
    out_name: str,
    preview_name: str | None,
    p: MaskParams,
    ignore_case: bool = False,
    ignore_folders: bool = False,
    progress: Progress = NO_PROGRESS,
    overlay: bool = False,
    overlay_color=OVERLAY_COLOR,
    overlay_opacity: float = OVERLAY_OPACITY,
) -> dict:
    """With ``overlay`` the saved images are the targets with the wall area tinted, instead
    of the white/black masks."""
    t_dir, c_dir = store.dataset_dir(target), store.dataset_dir(control)
    out_clean = clean_rename_name(out_name)
    prev_clean = clean_rename_name(preview_name) if preview_name else None
    check_output_names(store, [out_clean, prev_clean])

    m = match(store, target, control, ignore_case, ignore_folders)
    if not m["keys"]:
        raise DatasetError(f"타깃 데이터셋에 이미지가 없습니다: {target}")
    progress.set_total(len(m["keys"]))

    tmp_out = store.root / f".{out_clean}.masks"
    tmp_prev = store.root / f".{prev_clean}.masks" if prev_clean else None
    warnings: list[dict] = []
    made = 0
    try:
        for d in filter(None, [tmp_out, tmp_prev]):
            if d.exists():
                shutil.rmtree(d)
            d.mkdir()
        for key in m["keys"]:
            progress.step(key)
            t_item = m["targets"][key]
            t_path = t_dir / t_item.path
            has_control = key in m["controls"]
            if has_control:
                mask, tgt, resized = make_mask(t_path, c_dir / m["controls"][key].path, p)
            elif p.no_control == "skip":
                continue
            else:
                (mask, tgt), resized = alpha_mask(t_path, p), False

            # Same name as the target (sub folders kept), always PNG.
            rel = Path(t_item.path).with_suffix(".png")
            (tmp_out / rel).parent.mkdir(parents=True, exist_ok=True)
            if overlay:
                overlay_image(mask, tgt, overlay_color, overlay_opacity).save(tmp_out / rel)
            else:
                Image.fromarray(mask, mode="L").save(tmp_out / rel)
            made += 1
            if tmp_prev is not None:
                (tmp_prev / rel).parent.mkdir(parents=True, exist_ok=True)
                preview_image(mask, tgt, overlay_color, overlay_opacity).save(tmp_prev / rel)

            building = int((tgt[..., 3] > p.alpha_threshold).sum())
            cover = float((mask > 127).sum()) / max(building, 1) * 100
            notes = []
            if resized:
                notes.append("컨트롤 크기가 달라 리사이즈함")
            if has_control and cover < 3:
                notes.append(f"외벽 비율 {cover:.1f}% (너무 작음: 정렬 어긋남/임계값 확인)")
            if has_control and cover > 95:
                notes.append(f"외벽 비율 {cover:.1f}% (너무 큼: 정렬 어긋남 의심)")
            if notes:
                warnings.append({"key": key, "notes": notes})
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
        "overlay": overlay,
        "made": made,
        "only_target": m["only_target"],
        "only_control": m["only_control"],
        "no_control": p.no_control,
        "warnings": warnings,
    }
