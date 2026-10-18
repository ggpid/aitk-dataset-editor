from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import config
from .datasets import IMAGE_EXTS, DatasetError, DatasetStore, compare
from .thumbs import thumbnail

app = FastAPI(title="ai-toolkit Dataset Editor")


@app.exception_handler(DatasetError)
async def dataset_error_handler(_: Request, exc: DatasetError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


def store() -> DatasetStore:
    resolved = config.resolve_datasets_root()
    if resolved.path is None:
        raise HTTPException(412, resolved.error or "설정에서 ai-toolkit 경로를 입력하세요.")
    return DatasetStore(resolved.path)


# ---- settings -----------------------------------------------------------
class SettingsBody(BaseModel):
    aitk_path: str = ""
    datasets_override: str = ""


def settings_response() -> dict:
    s = config.load_settings()
    r = config.resolve_datasets_root(s)
    return {
        "aitk_path": s.aitk_path,
        "datasets_override": s.datasets_override,
        "datasets_root": str(r.path) if r.path else None,
        "datasets_root_exists": bool(r.path and r.path.is_dir()),
        "source": r.source,
        "aitk_valid": r.aitk_valid,
        "error": r.error,
    }


@app.get("/api/settings")
def get_settings():
    return settings_response()


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    aitk = body.aitk_path.strip().strip('"')
    if aitk and not Path(aitk).expanduser().is_dir():
        raise HTTPException(400, f"경로가 존재하지 않습니다: {aitk}")
    config.save_settings(
        config.Settings(aitk_path=aitk, datasets_override=body.datasets_override.strip().strip('"'))
    )
    return settings_response()


# ---- datasets -----------------------------------------------------------
class NameBody(BaseModel):
    name: str


@app.get("/api/datasets")
def list_datasets():
    return store().list_datasets()


@app.post("/api/datasets")
def create_dataset(body: NameBody):
    return {"name": store().create_dataset(body.name)}


@app.delete("/api/datasets/{name}")
def delete_dataset(name: str):
    store().delete_dataset(name)
    return {"ok": True}


@app.patch("/api/datasets/{name}")
def rename_dataset(name: str, body: NameBody):
    return {"name": store().rename_dataset(name, body.name)}


@app.get("/api/datasets/{name}/items")
def list_items(name: str):
    return [i.to_dict() for i in store().list_items(name)]


@app.post("/api/datasets/{name}/upload")
async def upload(name: str, files: list[UploadFile] = File(...)):
    payload = [(f.filename or "", await f.read()) for f in files]
    saved = await run_in_threadpool(store().save_files, name, payload)
    return {"files": saved}


class CaptionBody(BaseModel):
    path: str
    caption: str


@app.put("/api/datasets/{name}/caption")
def set_caption(name: str, body: CaptionBody):
    store().set_caption(name, body.path, body.caption)
    return {"ok": True}


class PathsBody(BaseModel):
    paths: list[str]


@app.post("/api/datasets/{name}/delete-items")
def delete_items(name: str, body: PathsBody):
    return {"deleted": store().delete_items(name, body.paths)}


@app.post("/api/datasets/{name}/flip")
def add_flips(name: str):
    return store().add_flips(name)


@app.delete("/api/datasets/{name}/flip")
def remove_flips(name: str):
    return store().remove_flips(name)


@app.get("/api/datasets/{name}/file")
def get_file(name: str, path: str):
    p = store().item_path(name, path)
    if not p.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    return FileResponse(p, headers={"Cache-Control": "no-cache"})


@app.get("/api/datasets/{name}/thumb")
async def get_thumb(name: str, path: str, size: int = 384):
    p = store().item_path(name, path)
    if not p.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    if p.suffix.lower() not in IMAGE_EXTS:
        return FileResponse(p)
    try:
        out = await run_in_threadpool(thumbnail, p, size)
    except OSError:
        return FileResponse(p)
    return FileResponse(out, media_type="image/webp", headers={"Cache-Control": "max-age=86400"})


# ---- compare ------------------------------------------------------------
@app.get("/api/compare")
def compare_datasets(
    a: str, b: str, ignore_case: bool = False, ignore_folders: bool = False
):
    s = store()
    return compare(s.list_items(a), s.list_items(b), ignore_case, ignore_folders)


class DeleteUnpairedBody(BaseModel):
    a: str
    b: str
    side: Literal["a", "b", "both"]
    ignore_case: bool = False
    ignore_folders: bool = False
    # Restrict deletion to these relative paths (per side). None = all unpaired.
    paths_a: list[str] | None = None
    paths_b: list[str] | None = None


@app.post("/api/compare/delete-unpaired")
def delete_unpaired(body: DeleteUnpairedBody):
    s = store()
    result = compare(s.list_items(body.a), s.list_items(body.b), body.ignore_case, body.ignore_folders)
    deleted = {"a": 0, "b": 0}
    for side, ds, items, only in (
        ("a", body.a, result["only_a"], body.paths_a),
        ("b", body.b, result["only_b"], body.paths_b),
    ):
        if body.side not in (side, "both"):
            continue
        targets = [it["path"] for it in items]
        if only is not None:
            allowed = set(only)
            targets = [t for t in targets if t in allowed]
        deleted[side] = s.delete_items(ds, targets)
    return {"deleted": deleted}


# ---- frontend -----------------------------------------------------------
FRONTEND_DIST = Path(
    os.environ.get("AITK_EDITOR_FRONTEND", config.BACKEND_DIR.parent / "frontend" / "dist")
)

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = (FRONTEND_DIST / full_path).resolve()
        if full_path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")


def run() -> None:
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8665"))
    uvicorn.run("app.main:app", host=host, port=port)
