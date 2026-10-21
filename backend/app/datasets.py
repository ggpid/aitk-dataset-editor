"""Filesystem operations on ai-toolkit datasets.

A dataset is a folder directly under the datasets root. Each media file may
have a caption file with the same stem and a ``.txt`` extension, e.g.
``cat_01.png`` + ``cat_01.txt``. Like ai-toolkit, files are found recursively,
hidden entries and ``_controls`` folders are skipped.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

from .progress import NO_PROGRESS, Progress

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v", ".flv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
# Images Pillow can flip and write back in the same format.
FLIPPABLE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
CAPTION_EXT = ".txt"
FLIP_SUFFIX = "_flip"
SKIP_DIRS = {"_controls"}


class DatasetError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def clean_dataset_name(name: str) -> str:
    """Same normalisation as ai-toolkit's create dataset route."""
    cleaned = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    if not cleaned.strip("_"):
        raise DatasetError("유효하지 않은 데이터셋 이름입니다.")
    return cleaned


def clean_rename_name(name: str) -> str:
    """Folder name for a rename: keeps case, letters (incl. Korean), digits, '_', '-', '.'."""
    cleaned = re.sub(r"[^\w.\-]+", "_", name.strip()).strip(" ")
    if not cleaned or cleaned.startswith(".") or not cleaned.strip("_.-"):
        raise DatasetError("유효하지 않은 데이터셋 이름입니다.")
    return cleaned


def clean_filename(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/"))
    base = re.sub(r"[^\w.\-]", "_", base)
    if not base or base.startswith("."):
        raise DatasetError(f"유효하지 않은 파일 이름입니다: {name}")
    return base


def kind_of(ext: str) -> str:
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "other"


def is_flip_stem(stem: str) -> bool:
    return stem.endswith(FLIP_SUFFIX)


def flip_name(path: Path) -> Path:
    return path.with_name(f"{path.stem}{FLIP_SUFFIX}{path.suffix}")


def caption_path(media: Path) -> Path:
    return media.with_suffix(CAPTION_EXT)


@dataclass
class Item:
    path: str  # relative to dataset folder, forward slashes
    key: str  # relative path without extension (used for pairing)
    name: str
    ext: str
    kind: str
    size: int
    mtime: float
    caption: str | None
    is_flip: bool

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "key": self.key,
            "name": self.name,
            "ext": self.ext,
            "kind": self.kind,
            "size": self.size,
            "mtime": self.mtime,
            "caption": self.caption,
            "is_flip": self.is_flip,
        }


class DatasetStore:
    def __init__(self, root: Path):
        self.root = root.resolve()

    # ---- path helpers -------------------------------------------------
    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def dataset_dir(self, name: str, must_exist: bool = True) -> Path:
        if not name or name in {".", ".."} or "/" in name or "\\" in name or name.startswith("."):
            raise DatasetError("유효하지 않은 데이터셋 이름입니다.")
        path = (self.root / name).resolve()
        if path.parent != self.root:
            raise DatasetError("유효하지 않은 데이터셋 이름입니다.")
        if must_exist and not path.is_dir():
            raise DatasetError(f"데이터셋을 찾을 수 없습니다: {name}", 404)
        return path

    def item_path(self, dataset: str, rel: str) -> Path:
        ds = self.dataset_dir(dataset)
        path = (ds / rel).resolve()
        if ds not in path.parents:
            raise DatasetError("유효하지 않은 파일 경로입니다.")
        return path

    # ---- datasets -----------------------------------------------------
    def list_datasets(self) -> list[dict]:
        self.ensure_root()
        result = []
        for entry in sorted(os.scandir(self.root), key=lambda e: e.name.lower()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            media = list(self._iter_media(Path(entry.path)))
            flips = sum(1 for p in media if is_flip_stem(p.stem))
            captions = sum(1 for p in media if caption_path(p).is_file())
            result.append(
                {
                    "name": entry.name,
                    "count": len(media),
                    "flip_count": flips,
                    "caption_count": captions,
                    "mtime": entry.stat().st_mtime,
                }
            )
        return result

    def create_dataset(self, name: str) -> str:
        self.ensure_root()
        cleaned = clean_dataset_name(name)
        path = self.dataset_dir(cleaned, must_exist=False)
        if path.exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {cleaned}", 409)
        path.mkdir()
        return cleaned

    def delete_dataset(self, name: str, progress: Progress = NO_PROGRESS) -> None:
        ds = self.dataset_dir(name)
        files = [Path(root) / f for root, _, names in os.walk(ds) for f in names]
        progress.set_total(len(files))
        for f in files:
            progress.step(f.relative_to(ds).as_posix())
            f.unlink(missing_ok=True)
        shutil.rmtree(ds)

    def rename_dataset(self, name: str, new_name: str) -> str:
        src = self.dataset_dir(name)
        cleaned = clean_rename_name(new_name)
        if cleaned == name:
            return name
        dst = self.dataset_dir(cleaned, must_exist=False)
        # On case-insensitive filesystems (Windows/macOS) "cat" -> "Cat" points at the same folder.
        same_folder = dst.exists() and os.path.samefile(src, dst)
        if dst.exists() and not same_folder:
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {cleaned}", 409)
        if same_folder:
            tmp = self.dataset_dir(f"{cleaned}.renaming", must_exist=False)
            src.rename(tmp)
            tmp.rename(self.root / cleaned)
        else:
            src.rename(dst)
        return cleaned

    def suggest_copy_name(self, name: str) -> str:
        base = f"{name}_copy"
        candidate, n = base, 2
        while (self.root / candidate).exists():
            candidate, n = f"{base}{n}", n + 1
        return candidate

    def duplicate_dataset(
        self, name: str, new_name: str, include_flips: bool = True, progress: Progress = NO_PROGRESS
    ) -> dict:
        """Copy a dataset folder. Hidden entries and ai-toolkit cache folders (*_cache) are skipped."""
        src = self.dataset_dir(name)
        cleaned = clean_rename_name(new_name)
        dst = self.dataset_dir(cleaned, must_exist=False)
        if dst.exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {cleaned}", 409)

        # Collect the files first so progress has a total.
        files: list[Path] = []
        folders: list[Path] = []
        skipped_flips = 0
        for root, dirs, names in os.walk(src):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not d.endswith("_cache")]
            folders += [Path(root, d).relative_to(src) for d in dirs]
            for n in names:
                if n.startswith("."):
                    continue
                stem, ext = os.path.splitext(n)
                if not include_flips and is_flip_stem(stem):
                    skipped_flips += ext.lower() in MEDIA_EXTS
                    continue
                files.append(Path(root, n).relative_to(src))
        progress.set_total(len(files))

        # Copy into a temporary folder first so a failed or cancelled copy never leaves a half dataset.
        tmp = self.root / f".{cleaned}.copying"
        if tmp.exists():
            shutil.rmtree(tmp)
        try:
            tmp.mkdir()
            for rel in folders:
                (tmp / rel).mkdir(parents=True, exist_ok=True)
            for rel in files:
                progress.step(rel.as_posix())
                shutil.copy2(src / rel, tmp / rel)
            tmp.rename(dst)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        count = sum(1 for _ in self._iter_media(dst))
        return {"name": cleaned, "count": count, "skipped_flips": skipped_flips}

    # ---- items --------------------------------------------------------
    def _iter_media(self, folder: Path):
        stack = [folder]
        while stack:
            current = stack.pop()
            try:
                entries = list(os.scandir(current))
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if entry.name not in SKIP_DIRS:
                        stack.append(Path(entry.path))
                elif entry.is_file() and os.path.splitext(entry.name)[1].lower() in MEDIA_EXTS:
                    yield Path(entry.path)

    def _item(self, ds: Path, path: Path) -> Item:
        rel = path.relative_to(ds).as_posix()
        stat = path.stat()
        cap = caption_path(path)
        caption = None
        if cap.is_file():
            caption = cap.read_text(encoding="utf-8", errors="replace")
        return Item(
            path=rel,
            key=rel[: -len(path.suffix)] if path.suffix else rel,
            name=path.name,
            ext=path.suffix.lower(),
            kind=kind_of(path.suffix),
            size=stat.st_size,
            mtime=stat.st_mtime,
            caption=caption,
            is_flip=is_flip_stem(path.stem),
        )

    def list_items(self, dataset: str) -> list[Item]:
        ds = self.dataset_dir(dataset)
        items = [self._item(ds, p) for p in self._iter_media(ds)]
        items.sort(key=lambda i: i.path.lower())
        return items

    def save_files(self, dataset: str, files: list[tuple[str, bytes]]) -> list[str]:
        ds = self.dataset_dir(dataset)
        saved = []
        for filename, data in files:
            name = clean_filename(filename)
            ext = os.path.splitext(name)[1].lower()
            if ext not in MEDIA_EXTS and ext != CAPTION_EXT:
                raise DatasetError(f"지원하지 않는 파일 형식입니다: {filename}")
            (ds / name).write_bytes(data)
            saved.append(name)
        return saved

    def set_caption(self, dataset: str, rel: str, caption: str) -> None:
        media = self.item_path(dataset, rel)
        if not media.is_file():
            raise DatasetError("파일을 찾을 수 없습니다.", 404)
        caption_path(media).write_text(caption, encoding="utf-8")

    def delete_item(self, dataset: str, rel: str) -> bool:
        media = self.item_path(dataset, rel)
        if media.suffix.lower() not in MEDIA_EXTS:
            raise DatasetError("미디어 파일이 아닙니다.")
        deleted = False
        if media.is_file():
            media.unlink()
            deleted = True
        cap = caption_path(media)
        # Only remove the caption if no other media file shares the stem.
        if cap.is_file() and not any(
            media.with_suffix(e).is_file() for e in MEDIA_EXTS if e != media.suffix.lower()
        ):
            cap.unlink()
        return deleted

    def delete_items(self, dataset: str, rels: list[str], progress: Progress = NO_PROGRESS) -> int:
        deleted = 0
        for rel in rels:
            progress.step(rel)
            deleted += self.delete_item(dataset, rel)
        return deleted

    def flip_companions(self, dataset: str, rel: str) -> list[str]:
        """Existing media linked to ``rel`` by the ``_flip`` naming rule, in both directions:
        ``a.png`` -> ``a_flip.*`` and ``a_flip.png`` -> ``a.*``."""
        ds = self.dataset_dir(dataset)
        media = self.item_path(dataset, rel)
        if is_flip_stem(media.stem):
            stem = media.stem[: -len(FLIP_SUFFIX)]
            if not stem:
                return []
        else:
            stem = f"{media.stem}{FLIP_SUFFIX}"
        found = []
        for ext in [media.suffix, *sorted(MEDIA_EXTS)]:
            cand = media.with_name(f"{stem}{ext}")
            if cand.is_file():
                r = cand.relative_to(ds).as_posix()
                if r not in found:
                    found.append(r)
        return found

    def delete_items_with_flips(
        self, dataset: str, rels: list[str], progress: Progress = NO_PROGRESS
    ) -> tuple[int, int]:
        """Delete items plus their linked original/``_flip`` counterparts.
        Returns (requested items deleted, extra linked items deleted).
        The caller sets the progress total (see ``count_with_flips``)."""
        linked = self._linked(dataset, rels)
        return self.delete_items(dataset, rels, progress), self.delete_items(dataset, linked, progress)

    def _linked(self, dataset: str, rels: list[str]) -> list[str]:
        requested = set(rels)
        out: list[str] = []
        for rel in rels:
            for c in self.flip_companions(dataset, rel):
                if c not in requested and c not in out:
                    out.append(c)
        return out

    def count_with_flips(self, dataset: str, rels: list[str]) -> int:
        return len(rels) + len(self._linked(dataset, rels))

    # ---- flip ---------------------------------------------------------
    def add_flips(self, dataset: str, progress: Progress = NO_PROGRESS) -> dict:
        ds = self.dataset_dir(dataset)
        created, skipped, unsupported = [], [], []
        originals = sorted(m for m in self._iter_media(ds) if not is_flip_stem(m.stem))
        progress.set_total(len(originals))
        for media in originals:
            rel = media.relative_to(ds).as_posix()
            progress.step(rel)
            if media.suffix.lower() not in FLIPPABLE_EXTS:
                unsupported.append(rel)
                continue
            target = flip_name(media)
            if target.exists():
                skipped.append(rel)
                continue
            flip_image(media, target)
            cap = caption_path(media)
            if cap.is_file():
                shutil.copyfile(cap, caption_path(target))
            created.append(target.relative_to(ds).as_posix())
        return {"created": created, "skipped": skipped, "unsupported": unsupported}

    def remove_flips(self, dataset: str, progress: Progress = NO_PROGRESS) -> dict:
        ds = self.dataset_dir(dataset)
        removed = []
        flips = [m for m in self._iter_media(ds) if is_flip_stem(m.stem)]
        progress.set_total(len(flips))
        for media in flips:
            rel = media.relative_to(ds).as_posix()
            progress.step(rel)
            self.delete_item(dataset, rel)
            removed.append(rel)
        # Orphan flip captions (media already gone).
        for cap in ds.rglob(f"*{FLIP_SUFFIX}{CAPTION_EXT}"):
            if not any(cap.with_suffix(e).exists() for e in MEDIA_EXTS):
                cap.unlink()
        return {"removed": sorted(removed)}


def flip_image(src: Path, dst: Path) -> None:
    """Mirror an image horizontally, keeping format and as much metadata as possible."""
    with Image.open(src) as im:
        fmt = im.format
        info = im.info
        # Bake EXIF rotation into pixels first so the flip matches what viewers show.
        upright = ImageOps.exif_transpose(im)
        flipped = upright.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        kwargs: dict = {}
        if info.get("icc_profile"):
            kwargs["icc_profile"] = info["icc_profile"]
        if fmt == "JPEG":
            kwargs.update(quality=95, subsampling=0)
            if flipped.mode not in ("RGB", "L", "CMYK"):
                flipped = flipped.convert("RGB")
        elif fmt == "WEBP":
            if info.get("lossless"):
                kwargs["lossless"] = True
            else:
                kwargs["quality"] = 95
        elif fmt == "PNG" and "dpi" in info:
            kwargs["dpi"] = info["dpi"]
        tmp = dst.with_name(dst.name + ".tmp")
        flipped.save(tmp, format=fmt, **kwargs)
        tmp.replace(dst)


# ---- comparison -------------------------------------------------------
def pair_key(item: Item, ignore_case: bool, ignore_folders: bool) -> str:
    key = item.key.rsplit("/", 1)[-1] if ignore_folders else item.key
    return key.lower() if ignore_case else key


def compare(
    a_items: list[Item], b_items: list[Item], ignore_case: bool = False, ignore_folders: bool = False
) -> dict:
    # _flip files are derived data: leave them out of the comparison entirely.
    a_items = [it for it in a_items if not it.is_flip]
    b_items = [it for it in b_items if not it.is_flip]
    def index(items: list[Item]) -> dict[str, Item]:
        out: dict[str, Item] = {}
        for it in items:
            # If several files share a key (e.g. a.png + a.jpg) the first one wins.
            out.setdefault(pair_key(it, ignore_case, ignore_folders), it)
        return out

    a_idx, b_idx = index(a_items), index(b_items)
    paired = [
        {"key": k, "a": a_idx[k].to_dict(), "b": b_idx[k].to_dict()}
        for k in sorted(a_idx.keys() & b_idx.keys(), key=str.lower)
    ]
    only_a = [it.to_dict() for it in a_items if pair_key(it, ignore_case, ignore_folders) not in b_idx]
    only_b = [it.to_dict() for it in b_items if pair_key(it, ignore_case, ignore_folders) not in a_idx]
    return {"paired": paired, "only_a": only_a, "only_b": only_b}
