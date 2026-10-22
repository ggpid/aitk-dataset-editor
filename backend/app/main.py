from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import alphamask, config, overlay, sam, wallmask
from .datasets import IMAGE_EXTS, DatasetError, DatasetStore, clean_rename_name, compare
from .jobs import jobs
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


@app.get("/api/datasets/{name}/stats")
def dataset_stats(name: str):
    return store().dataset_stats(name)


@app.post("/api/datasets")
def create_dataset(body: NameBody):
    return {"name": store().create_dataset(body.name)}


def job_response(job) -> dict:
    return {"job": job.to_dict()}


@app.delete("/api/datasets/{name}")
def delete_dataset(name: str):
    s = store()
    s.dataset_dir(name)
    return job_response(
        jobs.start("delete_dataset", f"'{name}' 데이터셋 삭제", [name], lambda j: s.delete_dataset(name, j))
    )


@app.patch("/api/datasets/{name}")
def rename_dataset(name: str, body: NameBody):
    busy = [j for j in jobs.list(active_only=True) if name in j.datasets]
    if busy:
        raise DatasetError(f"'{busy[0].title}' 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", 409)
    return {"name": store().rename_dataset(name, body.name)}


class DuplicateBody(BaseModel):
    name: str
    include_flips: bool = True


@app.get("/api/datasets/{name}/duplicate-name")
def suggest_duplicate_name(name: str):
    s = store()
    s.dataset_dir(name)
    return {"name": s.suggest_copy_name(name)}


@app.post("/api/datasets/{name}/duplicate")
def duplicate_dataset(name: str, body: DuplicateBody):
    s = store()
    s.dataset_dir(name)
    # Validate up front so name errors show immediately instead of as a failed job.
    new = clean_rename_name(body.name)
    if s.dataset_dir(new, must_exist=False).exists():
        raise DatasetError(f"이미 존재하는 데이터셋입니다: {new}", 409)
    return job_response(
        jobs.start(
            "duplicate",
            f"'{name}' → '{new}' 복제",
            [name, new],
            lambda j: s.duplicate_dataset(name, new, body.include_flips, j),
        )
    )


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
    # Also delete each item's <stem>_flip.* companion (used by the compare view).
    with_flips: bool = False


@app.post("/api/datasets/{name}/delete-items")
def delete_items(name: str, body: PathsBody):
    s = store()
    s.dataset_dir(name)

    def run(j):
        if body.with_flips:
            j.set_total(s.count_with_flips(name, body.paths))
            deleted, flips = s.delete_items_with_flips(name, body.paths, j)
            return {"deleted": deleted, "flips_deleted": flips}
        j.set_total(len(body.paths))
        return {"deleted": s.delete_items(name, body.paths, j), "flips_deleted": 0}

    return job_response(jobs.start("delete_items", f"'{name}' 항목 {len(body.paths)}개 삭제", [name], run))


@app.get("/api/datasets/{name}/alpha-mask/info")
def alpha_mask_info(name: str):
    return alphamask.info(store(), name)


class AlphaMaskPreviewBody(BaseModel):
    path: str
    threshold: int = 16
    grow_px: int = 0


@app.post("/api/datasets/{name}/alpha-mask/preview")
async def alpha_mask_preview(name: str, body: AlphaMaskPreviewBody):
    png, info = await run_in_threadpool(
        alphamask.preview_png, store(), name, body.path,
        max(0, min(255, body.threshold)), max(-128, min(128, body.grow_px)),
    )
    return Response(png, media_type="image/png", headers={
        "X-Mask-Cover": str(info["cover"]),
        "X-Mask-Has-Alpha": "1" if info["had_alpha"] else "0",
        "Cache-Control": "no-store",
    })


class AlphaMaskBody(BaseModel):
    name: str
    preview_name: str | None = None
    threshold: int = 16
    grow_px: int = 0
    include_flips: bool = True


@app.post("/api/datasets/{name}/alpha-mask")
def make_alpha_masks(name: str, body: AlphaMaskBody):
    s = store()
    s.dataset_dir(name)
    names = [clean_rename_name(body.name)]
    if body.preview_name:
        names.append(clean_rename_name(body.preview_name))
        if names[0] == names[1]:
            raise DatasetError("마스크와 미리보기 데이터셋 이름이 같습니다.")
    for n in names:
        if s.dataset_dir(n, must_exist=False).exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {n}", 409)
    return job_response(
        jobs.start(
            "alpha_masks",
            f"'{name}' 불투명 영역 마스크 → '{names[0]}'",
            names,
            lambda j: alphamask.make_alpha_mask_dataset(
                s, name, body.name, body.preview_name,
                max(0, min(255, body.threshold)), max(-128, min(128, body.grow_px)), body.include_flips, j,
            ),
        )
    )


@app.post("/api/datasets/{name}/flip")
def add_flips(name: str):
    s = store()
    s.dataset_dir(name)
    return job_response(jobs.start("add_flips", f"'{name}' flip 이미지 생성", [name], lambda j: s.add_flips(name, j)))


@app.delete("/api/datasets/{name}/flip")
def remove_flips(name: str):
    s = store()
    s.dataset_dir(name)
    return job_response(jobs.start("remove_flips", f"'{name}' _flip 제거", [name], lambda j: s.remove_flips(name, j)))


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


# ---- convert: BiRefNet -> SAM (SA-1B) -------------------------------------
class SamBody(BaseModel):
    image_dataset: str
    mask_dataset: str | None = None
    image_dir: str = "im"
    mask_dir: str = "gt"
    output: str = ""
    threshold: int = 128
    split: bool = False
    min_area: int = 64
    to_jpg: bool = True
    skip_empty: bool = True


@app.post("/api/convert/sam/preview")
def sam_preview(body: SamBody):
    return sam.preview(store(), sam.SamOptions(**body.model_dump()))


@app.post("/api/convert/sam")
def sam_convert(body: SamBody):
    s = store()
    opt = sam.SamOptions(**body.model_dump())
    sam.sources(s, opt)  # validate before starting the job
    out = clean_rename_name(opt.output)
    if s.dataset_dir(out, must_exist=False).exists():
        raise HTTPException(409, f"이미 존재하는 데이터셋입니다: {out}")
    names = [n for n in (opt.image_dataset, opt.mask_dataset, out) if n]
    return job_response(
        jobs.start("convert_sam", f"'{opt.image_dataset}' → SAM 데이터셋 '{out}'", names, lambda j: sam.convert(s, opt, j))
    )


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


class SaveOverlayBody(BaseModel):
    a: str
    b: str
    name: str
    opacity: float  # 0..1, B over A
    stretch: bool = True
    captions: Literal["a", "b", "none"] = "a"
    keys: list[str] | None = None  # pair keys to include; None = all pairs
    ignore_case: bool = False
    ignore_folders: bool = False


@app.post("/api/compare/save-overlay")
def save_overlay(body: SaveOverlayBody):
    s = store()
    s.dataset_dir(body.a)
    s.dataset_dir(body.b)
    new = clean_rename_name(body.name)
    if s.dataset_dir(new, must_exist=False).exists():
        raise DatasetError(f"이미 존재하는 데이터셋입니다: {new}", 409)
    return job_response(
        jobs.start(
            "save_overlay",
            f"'{body.a}' + '{body.b}' 겹치기 → '{new}'",
            [new],
            lambda j: overlay.save_overlay_dataset(
                s, body.a, body.b, new, body.opacity, body.stretch, body.captions,
                body.keys, body.ignore_case, body.ignore_folders, j,
            ),
        )
    )


class MaskParamsBody(BaseModel):
    diff_threshold: int = 40
    alpha_threshold: int = 16
    open_px: int = 1
    close_px: int = 4
    dilate_px: int = 8
    no_control: Literal["alpha", "skip"] = "alpha"

    def params(self) -> wallmask.MaskParams:
        clamp = lambda v, hi: max(0, min(hi, v))  # noqa: E731
        return wallmask.MaskParams(
            clamp(self.diff_threshold, 255), clamp(self.alpha_threshold, 255),
            clamp(self.open_px, 64), clamp(self.close_px, 64), clamp(self.dilate_px, 128), self.no_control,
        )


class MaskSourceBody(BaseModel):
    target: str  # painted building (training images)
    control: str  # white building
    ignore_case: bool = False
    ignore_folders: bool = False


@app.post("/api/compare/masks/info")
def masks_info(body: MaskSourceBody):
    m = wallmask.match(store(), body.target, body.control, body.ignore_case, body.ignore_folders)
    paired = [k for k in m["keys"] if k in m["controls"]]
    return {
        "targets": len(m["keys"]),
        "pairs": len(paired),
        "only_target": m["only_target"],
        "only_control": m["only_control"],
        "sample_keys": paired[:500],
    }


class MaskPreviewBody(MaskSourceBody):
    key: str
    params: MaskParamsBody = MaskParamsBody()


@app.post("/api/compare/masks/preview")
async def masks_preview(body: MaskPreviewBody):
    png, info = await run_in_threadpool(
        wallmask.preview_png, store(), body.target, body.control, body.key, body.params.params(),
        body.ignore_case, body.ignore_folders,
    )
    return Response(png, media_type="image/png", headers={
        "X-Mask-Cover": str(info["cover"]),
        "X-Mask-Resized": "1" if info["resized"] else "0",
        "X-Mask-Has-Control": "1" if info["has_control"] else "0",
        "Cache-Control": "no-store",
    })


class MakeMasksBody(MaskSourceBody):
    name: str
    preview_name: str | None = None
    params: MaskParamsBody = MaskParamsBody()


@app.post("/api/compare/masks")
def make_masks(body: MakeMasksBody):
    s = store()
    s.dataset_dir(body.target)
    s.dataset_dir(body.control)
    names = [clean_rename_name(body.name)]
    if body.preview_name:
        names.append(clean_rename_name(body.preview_name))
        if names[0] == names[1]:
            raise DatasetError("마스크와 미리보기 데이터셋 이름이 같습니다.")
    for n in names:
        if s.dataset_dir(n, must_exist=False).exists():
            raise DatasetError(f"이미 존재하는 데이터셋입니다: {n}", 409)
    return job_response(
        jobs.start(
            "wall_masks",
            f"'{body.target}' 마스크 생성 → '{names[0]}'",
            names,
            lambda j: wallmask.make_mask_dataset(
                s, body.target, body.control, body.name, body.preview_name, body.params.params(),
                body.ignore_case, body.ignore_folders, j,
            ),
        )
    )


@app.post("/api/compare/delete-unpaired")
def delete_unpaired(body: DeleteUnpairedBody):
    s = store()
    s.dataset_dir(body.a)
    s.dataset_dir(body.b)

    def run(j):
        j.note("짝 비교 중…")
        result = compare(s.list_items(body.a), s.list_items(body.b), body.ignore_case, body.ignore_folders)
        plan = []
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
            plan.append((side, ds, targets))
        j.set_total(sum(s.count_with_flips(ds, t) for _, ds, t in plan))
        deleted = {"a": 0, "b": 0}
        flips = {"a": 0, "b": 0}
        for side, ds, targets in plan:
            deleted[side], flips[side] = s.delete_items_with_flips(ds, targets, j)
        return {"deleted": deleted, "flips_deleted": flips}

    names = sorted({body.a, body.b})
    return job_response(jobs.start("delete_unpaired", "짝없는 데이터 삭제", names, run))


# ---- jobs ---------------------------------------------------------------
@app.get("/api/jobs")
def list_jobs(active: bool = False):
    return [j.to_dict() for j in jobs.list(active_only=active)]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    job.cancel()
    return job.to_dict()


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
