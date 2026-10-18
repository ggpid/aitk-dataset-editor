"""Editor settings and resolution of the ai-toolkit datasets folder.

ai-toolkit stores its datasets folder in the ``Settings`` table of
``<ai-toolkit>/aitk_db.db`` (key ``DATASETS_FOLDER``). When that value is empty
the UI falls back to ``<ai-toolkit>/datasets``. We follow the same rules so the
editor always works on the same folder the ai-toolkit UI shows.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import asdict, dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("AITK_EDITOR_CONFIG", BACKEND_DIR / "config.json"))
CACHE_DIR = Path(os.environ.get("AITK_EDITOR_CACHE", BACKEND_DIR / ".cache"))

_lock = threading.Lock()


@dataclass
class Settings:
    aitk_path: str = ""
    # Optional: use this folder instead of the one configured in ai-toolkit.
    datasets_override: str = ""


def load_settings() -> Settings:
    with _lock:
        if not CONFIG_PATH.exists():
            return Settings()
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return Settings()
        return Settings(
            aitk_path=str(data.get("aitk_path", "") or ""),
            datasets_override=str(data.get("datasets_override", "") or ""),
        )


def save_settings(settings: Settings) -> None:
    with _lock:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(settings), indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(CONFIG_PATH)


def read_aitk_db_datasets_folder(aitk_path: Path) -> str | None:
    """Return DATASETS_FOLDER from ai-toolkit's sqlite DB, or None."""
    db_path = aitk_path / "aitk_db.db"
    if not db_path.is_file():
        return None
    try:
        # Read-only so we never lock or modify ai-toolkit's database.
        con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute(
                "SELECT value FROM Settings WHERE key = 'DATASETS_FOLDER'"
            ).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    if row and row[0] and str(row[0]).strip():
        return str(row[0]).strip()
    return None


@dataclass
class ResolvedRoot:
    path: Path | None
    source: str  # "override" | "aitk_db" | "default" | "unset"
    aitk_valid: bool
    error: str | None = None


def looks_like_aitk(path: Path) -> bool:
    return path.is_dir() and (
        (path / "run.py").is_file() or (path / "toolkit").is_dir() or (path / "ui").is_dir()
    )


def resolve_datasets_root(settings: Settings | None = None) -> ResolvedRoot:
    settings = settings or load_settings()
    aitk = Path(settings.aitk_path).expanduser() if settings.aitk_path else None
    aitk_valid = bool(aitk and looks_like_aitk(aitk))

    if settings.datasets_override.strip():
        return ResolvedRoot(
            Path(settings.datasets_override.strip()).expanduser().resolve(), "override", aitk_valid
        )
    if not aitk:
        return ResolvedRoot(None, "unset", False, "ai-toolkit 경로가 설정되지 않았습니다.")
    if not aitk.is_dir():
        return ResolvedRoot(None, "unset", False, f"경로가 존재하지 않습니다: {aitk}")

    from_db = read_aitk_db_datasets_folder(aitk)
    if from_db:
        p = Path(from_db).expanduser()
        if not p.is_absolute():
            p = aitk / p
        return ResolvedRoot(p.resolve(), "aitk_db", aitk_valid)
    return ResolvedRoot((aitk / "datasets").resolve(), "default", aitk_valid)
