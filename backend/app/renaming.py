"""Batch prefix / suffix renaming of dataset items.

Each media file is renamed together with its caption (.txt). The suffix goes before a
trailing ``_flip`` so originals and their flips stay linked (``a_flip.png`` + ``_v2`` →
``a_v2_flip.png``). Linked flips/originals and the items' guides in ``<dataset>_pattern``
can be renamed along. Nothing is renamed when any new name collides with an existing file.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from .datasets import CAPTION_EXT, FLIP_SUFFIX, DatasetError, DatasetStore, is_flip_stem

_SAFE = re.compile(r"^[\w.\-]*$")


def _check_affix(value: str, label: str) -> str:
    value = value.strip()
    if not _SAFE.match(value):
        raise DatasetError(f"{label}에는 글자·숫자·_ - . 만 쓸 수 있습니다: {value!r}")
    return value


def new_stem(stem: str, prefix: str, suffix: str) -> str:
    if is_flip_stem(stem):
        return f"{prefix}{stem[: -len(FLIP_SUFFIX)]}{suffix}{FLIP_SUFFIX}"
    return f"{prefix}{stem}{suffix}"


def plan(
    store: DatasetStore,
    dataset: str,
    paths: list[str],
    prefix: str,
    suffix: str,
    include_linked: bool = True,
    include_patterns: bool = True,
) -> dict:
    prefix = _check_affix(prefix, "접두사")
    suffix = _check_affix(suffix, "접미사")
    if not prefix and not suffix:
        raise DatasetError("접두사나 접미사를 입력하세요.")
    ds = store.dataset_dir(dataset)

    rels: list[str] = []
    for p in paths:
        if store.item_path(dataset, p).is_file() and p not in rels:
            rels.append(p)
    linked = store._linked(dataset, rels) if include_linked else []
    items = rels + linked

    moves: list[tuple[Path, Path]] = []  # every file move (media, captions, patterns)
    renames: list[dict] = []  # media items, for the preview
    for rel in items:
        src = ds / rel
        dst = src.with_name(new_stem(src.stem, prefix, suffix) + src.suffix)
        renames.append({"from": rel, "to": dst.relative_to(ds).as_posix(), "linked": rel in linked})
        moves.append((src, dst))
        cap = src.with_suffix(CAPTION_EXT)
        if cap.is_file():
            moves.append((cap, dst.with_suffix(CAPTION_EXT)))

    pattern_moves: list[tuple[Path, Path]] = []
    pat_dir = store.root / f"{dataset}_pattern"
    if include_patterns and pat_dir.is_dir():
        for rel in items:
            src = pat_dir / Path(rel).with_suffix(".png")
            if src.is_file():
                pattern_moves.append((src, src.with_name(new_stem(src.stem, prefix, suffix) + ".png")))

    sources = {s for s, _ in moves + pattern_moves}
    conflicts = sorted(
        d.relative_to(store.root).as_posix()
        for _, d in moves + pattern_moves
        if d.exists() and d not in sources
    )
    targets = [d for _, d in moves + pattern_moves]
    dupes = sorted({d.relative_to(store.root).as_posix() for d in targets if targets.count(d) > 1})
    return {
        "renames": renames,
        "linked": len(linked),
        "captions": sum(1 for s, _ in moves if s.suffix == CAPTION_EXT),
        "patterns": len(pattern_moves),
        "conflicts": conflicts + dupes,
        "_moves": moves + pattern_moves,
    }


def apply(store: DatasetStore, dataset: str, paths: list[str], prefix: str, suffix: str,
          include_linked: bool = True, include_patterns: bool = True) -> dict:
    p = plan(store, dataset, paths, prefix, suffix, include_linked, include_patterns)
    if p["conflicts"]:
        raise DatasetError(f"이미 있는 이름과 겹쳐 바꾸지 않았습니다: {', '.join(p['conflicts'][:5])}", 409)
    moves: list[tuple[Path, Path]] = p.pop("_moves")
    # Two phases through temporary names so chains (a→b while b→c) never collide.
    tag = uuid.uuid4().hex[:8]
    staged: list[tuple[Path, Path, Path]] = []
    try:
        for src, dst in moves:
            tmp = src.with_name(f".{src.name}.{tag}.renaming")
            src.rename(tmp)
            staged.append((src, tmp, dst))
        for _, tmp, dst in staged:
            tmp.rename(dst)
    except OSError:
        # Roll back whatever was moved.
        for src, tmp, dst in reversed(staged):
            if tmp.exists():
                tmp.rename(src)
            elif dst.exists() and not src.exists():
                dst.rename(src)
        raise
    return {k: v for k, v in p.items() if k != "conflicts"} | {"renamed": len(p["renames"])}
