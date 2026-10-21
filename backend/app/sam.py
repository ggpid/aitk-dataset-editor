"""Convert a BiRefNet-style dataset (images + foreground masks) to SAM's SA-1B format.

BiRefNet / DIS5K layout: ``im/<name>.jpg`` with a same-named grayscale mask
``gt/<name>.png`` (white = foreground). The masks can also live in a separate dataset.

SA-1B layout (what SAM / SAM 2 fine-tuning code reads): every image ``<name>.jpg``
sits next to ``<name>.json``::

    {"image": {"image_id", "width", "height", "file_name"},
     "annotations": [{"id", "segmentation": {"size": [h, w], "counts": <COCO RLE>},
                      "area", "bbox": [x, y, w, h], "predicted_iou", "stability_score",
                      "point_coords": [[x, y]], "crop_box": [x, y, w, h]}]}
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from .datasets import IMAGE_EXTS, DatasetError, DatasetStore, clean_rename_name, skip_dir
from .progress import NO_PROGRESS, Progress


# ---- COCO RLE --------------------------------------------------------------
def rle_counts(mask: np.ndarray) -> list[int]:
    """Uncompressed COCO RLE: run lengths over the column-major pixels, starting with 0s."""
    flat = np.asarray(mask, dtype=np.uint8).ravel(order="F")
    if flat.size == 0:
        return []
    change = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    bounds = np.concatenate(([0], change, [flat.size]))
    runs = np.diff(bounds).tolist()
    return [0, *runs] if flat[0] else runs


def rle_to_string(counts: list[int]) -> str:
    """pycocotools' compact string encoding (rleToString in maskApi.c)."""
    out = []
    for i, x in enumerate(counts):
        if i > 2:
            x -= counts[i - 2]
        more = True
        while more:
            c = x & 0x1F
            x >>= 5
            more = (x != -1) if (c & 0x10) else (x != 0)
            if more:
                c |= 0x20
            out.append(chr(c + 48))
    return "".join(out)


def encode_mask(mask: np.ndarray) -> dict:
    h, w = mask.shape
    return {"size": [int(h), int(w)], "counts": rle_to_string(rle_counts(mask))}


# ---- masks -------------------------------------------------------------------
def load_mask(path: Path, size: tuple[int, int], threshold: int) -> tuple[np.ndarray, bool]:
    """Binary mask at ``size`` (w, h). Returns (mask, resized)."""
    with Image.open(path) as im:
        # Cut-outs saved as RGBA keep the matte in alpha; plain masks are grayscale.
        if "A" in im.getbands() and im.getextrema()[-1][0] < 255:
            gray = im.getchannel("A")
        else:
            gray = im.convert("L")
        resized = gray.size != size
        if resized:
            gray = gray.resize(size, Image.Resampling.BILINEAR)
        return np.asarray(gray) >= threshold, resized


def annotation(mask: np.ndarray, ann_id: int, crop_box: list[int]) -> dict:
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    # Prompt point: the pixel deepest inside the object (always inside, even for ring shapes).
    sub = np.pad(mask[y0 : y1 + 1, x0 : x1 + 1], 1)
    dist = ndimage.distance_transform_edt(sub)
    py, px = np.unravel_index(int(np.argmax(dist)), dist.shape)
    return {
        "id": ann_id,
        "segmentation": encode_mask(mask),
        "area": int(xs.size),
        "bbox": [float(x0), float(y0), float(x1 - x0 + 1), float(y1 - y0 + 1)],
        "predicted_iou": 1.0,
        "stability_score": 1.0,
        "point_coords": [[float(x0 + px - 1), float(y0 + py - 1)]],
        "crop_box": crop_box,
    }


def split_objects(mask: np.ndarray, min_area: int) -> list[np.ndarray]:
    labels, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    if n == 0:
        return []
    areas = np.bincount(labels.ravel())[1:]
    return [labels == i + 1 for i in np.flatnonzero(areas >= max(1, min_area))]


# ---- conversion ------------------------------------------------------------
@dataclass
class SamOptions:
    image_dataset: str
    mask_dataset: str | None = None  # None: masks are a subfolder of image_dataset
    image_dir: str = "im"
    mask_dir: str = "gt"
    output: str = ""
    threshold: int = 128
    split: bool = False  # one annotation per connected component
    min_area: int = 64
    to_jpg: bool = True
    skip_empty: bool = True


def _index(folder: Path) -> dict[str, Path]:
    """Images under ``folder`` keyed by relative path without extension."""
    out: dict[str, Path] = {}
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not skip_dir(d))
        for f in sorted(files):
            stem, ext = os.path.splitext(f)
            if f.startswith(".") or ext.lower() not in IMAGE_EXTS:
                continue
            rel = Path(root, stem).relative_to(folder).as_posix()
            out.setdefault(rel, Path(root, f))
    return out


def sources(store: DatasetStore, opt: SamOptions) -> tuple[Path, Path]:
    img_ds = store.dataset_dir(opt.image_dataset)
    if opt.mask_dataset:
        return img_ds, store.dataset_dir(opt.mask_dataset)
    img, mask = (img_ds / opt.image_dir).resolve(), (img_ds / opt.mask_dir).resolve()
    for p, label in ((img, "이미지"), (mask, "마스크")):
        if img_ds not in p.parents or not p.is_dir():
            raise DatasetError(f"{label} 폴더가 없습니다: {opt.image_dataset}/{p.name}")
    return img, mask


def _free_name(store: DatasetStore, base: str) -> str:
    name, n = base, 2
    while (store.root / name).exists():
        name, n = f"{base}{n}", n + 1
    return name


def preview(store: DatasetStore, opt: SamOptions) -> dict:
    img_dir, mask_dir = sources(store, opt)
    images, masks = _index(img_dir), _index(mask_dir)
    paired = sorted(images.keys() & masks.keys())
    return {
        "images": len(images),
        "masks": len(masks),
        "pairs": len(paired),
        "images_without_mask": len(images.keys() - masks.keys()),
        "masks_without_image": len(masks.keys() - images.keys()),
        "examples": paired[:5],
        "suggested_output": _free_name(store, f"{opt.image_dataset}_sam"),
    }


def convert(store: DatasetStore, opt: SamOptions, progress: Progress = NO_PROGRESS) -> dict:
    img_dir, mask_dir = sources(store, opt)
    out_name = clean_rename_name(opt.output)
    dst = store.dataset_dir(out_name, must_exist=False)
    if dst.exists():
        raise DatasetError(f"이미 존재하는 데이터셋입니다: {out_name}", 409)
    if not 1 <= opt.threshold <= 255:
        raise DatasetError("임계값은 1~255 사이여야 합니다.")

    images, masks = _index(img_dir), _index(mask_dir)
    keys = sorted(images.keys() & masks.keys())
    if not keys:
        raise DatasetError("이름이 같은 이미지/마스크 쌍이 없습니다.")
    progress.set_total(len(keys))

    # Build in a hidden temp folder so a cancelled/failed run leaves nothing behind.
    tmp = store.root / f".{out_name}.converting"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()
    stats = {"written": 0, "annotations": 0, "empty_skipped": 0, "resized_masks": 0, "converted_to_jpg": 0}
    used: set[str] = set()
    try:
        for idx, key in enumerate(keys, 1):
            progress.step(key)
            src_img, src_mask = images[key], masks[key]
            stem = key.replace("/", "__")
            ext = src_img.suffix.lower()
            jpg = opt.to_jpg and ext not in (".jpg", ".jpeg")
            out_ext = ".jpg" if jpg else ext
            if stem.lower() in used:
                stem = f"{stem}_{idx}"
            used.add(stem.lower())

            with Image.open(src_img) as im:
                w, h = im.size
                mask, resized = load_mask(src_mask, (w, h), opt.threshold)
                if not mask.any() and opt.skip_empty:
                    stats["empty_skipped"] += 1
                    continue
                if jpg:
                    rgb = im.convert("RGBA") if "A" in im.getbands() or im.mode == "P" else im
                    if rgb.mode == "RGBA":
                        bg = Image.new("RGB", rgb.size, (255, 255, 255))
                        bg.paste(rgb, mask=rgb.getchannel("A"))
                        rgb = bg
                    rgb.convert("RGB").save(tmp / f"{stem}.jpg", quality=95)
                    stats["converted_to_jpg"] += 1
            if not jpg:
                shutil.copy2(src_img, tmp / f"{stem}{out_ext}")
            stats["resized_masks"] += resized

            crop_box = [0, 0, w, h]
            parts = split_objects(mask, opt.min_area) if opt.split else ([mask] if mask.any() else [])
            anns = [annotation(m, i, crop_box) for i, m in enumerate(parts, 1)]
            record = {
                "image": {"image_id": idx, "width": w, "height": h, "file_name": f"{stem}{out_ext}"},
                "annotations": anns,
            }
            (tmp / f"{stem}.json").write_text(json.dumps(record), encoding="utf-8")
            stats["written"] += 1
            stats["annotations"] += len(anns)
        tmp.rename(dst)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {
        "name": out_name,
        **stats,
        "images_without_mask": len(images.keys() - masks.keys()),
        "masks_without_image": len(masks.keys() - images.keys()),
    }
