"""Merge several datasets into a new one.

Media files and their captions (.txt) are copied, keeping sub folders. When the same
name exists in several sources it is resolved by ``strategy``:

- ``prefix_conflicts``: colliding items get ``<source>_`` in front of their name
- ``prefix_all``: every item gets ``<source>_`` in front of its name
- ``skip``: the first source (in the given order) wins, later ones are skipped

An original and its ``_flip`` copy are treated as one group so they stay linked.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Literal

from .datasets import CAPTION_EXT, FLIP_SUFFIX, DatasetError, DatasetStore, clean_rename_name, is_flip_stem
from .progress import NO_PROGRESS, Progress

Strategy = Literal["prefix_conflicts", "prefix_all", "skip"]


def _group(key: str) -> str:
    """Original's key for an item key (``sub/a_flip`` -> ``sub/a``)."""
    head, _, stem = key.rpartition("/")
    if is_flip_stem(stem):
        stem = stem[: -len(FLIP_SUFFIX)]
    return f"{head}/{stem}" if head else stem


def _prefixed(rel: str, prefix: str) -> str:
    p = Path(rel)
    return p.with_name(prefix + p.name).as_posix()


def plan(store: DatasetStore, sources: list[str], strategy: Strategy, include_flips: bool = True) -> dict:
    if len(sources) < 2:
        raise DatasetError("합칠 데이터셋을 두 개 이상 고르세요.")
    if len(set(sources)) != len(sources):
        raise DatasetError("같은 데이터셋이 두 번 들어 있습니다.")

    per_source: list[tuple[str, list]] = []
    owners: dict[str, list[str]] = {}  # group key -> sources having it
    for src in sources:
        store.dataset_dir(src)
        items = [it for it in store.list_items(src) if include_flips or not it.is_flip]
        per_source.append((src, items))
        for g in sorted({_group(it.key) for it in items}):
            owners.setdefault(g, []).append(src)
    conflicts = sorted((g for g, o in owners.items() if len(o) > 1), key=str.lower)
    conflict_set = set(conflicts)

    files: list[tuple[str, str, str]] = []  # (source, source rel path, target rel path)
    skipped = 0
    for src, items in per_source:
        for it in items:
            g = _group(it.key)
            if strategy == "skip" and g in conflict_set and owners[g][0] != src:
                skipped += 1
                continue
            prefix = f"{src}_" if strategy == "prefix_all" or (strategy == "prefix_conflicts" and g in conflict_set) else ""
            files.append((src, it.path, _prefixed(it.path, prefix) if prefix else it.path))

    targets: dict[str, str] = {}
    clashes: list[str] = []
    for src, _, dst in files:
        key = str(Path(dst).with_suffix("")).lower()  # a.png and a.jpg would share a caption
        if key in targets and targets[key] != src:
            clashes.append(dst)
        targets.setdefault(key, src)
    return {
        "items": len(files),
        "per_source": {src: len(items) for src, items in per_source},
        "conflicts": conflicts,
        "skipped": skipped,
        "clashes": sorted(set(clashes)),
        "_files": files,
    }


def merge(
    store: DatasetStore,
    sources: list[str],
    name: str,
    strategy: Strategy = "prefix_conflicts",
    include_flips: bool = True,
    progress: Progress = NO_PROGRESS,
) -> dict:
    new = clean_rename_name(name)
    if store.dataset_dir(new, must_exist=False).exists():
        raise DatasetError(f"이미 존재하는 데이터셋입니다: {new}", 409)
    p = plan(store, sources, strategy, include_flips)
    if p["clashes"]:
        raise DatasetError(f"합친 뒤 이름이 겹치는 파일이 있습니다: {', '.join(p['clashes'][:5])}", 409)
    files = p.pop("_files")
    progress.set_total(len(files))

    tmp = store.root / f".{new}.merging"
    if tmp.exists():
        shutil.rmtree(tmp)
    captions = 0
    try:
        tmp.mkdir()
        for src, rel, dst_rel in files:
            progress.step(f"{src}/{rel}")
            s = store.dataset_dir(src) / rel
            d = tmp / dst_rel
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)
            cap = s.with_suffix(CAPTION_EXT)
            if cap.is_file():
                shutil.copy2(cap, d.with_suffix(CAPTION_EXT))
                captions += 1
        tmp.rename(store.root / new)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"name": new, "items": len(files), "captions": captions, "conflicts": len(p["conflicts"]), "skipped": p["skipped"]}
