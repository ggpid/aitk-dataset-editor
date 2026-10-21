import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture()
def env(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr("app.thumbs.CACHE_DIR", tmp_path / "cache")
    aitk = tmp_path / "ai-toolkit"
    (aitk / "toolkit").mkdir(parents=True)
    (aitk / "run.py").write_text("")
    from app.main import app

    client = TestClient(app)
    r = client.put("/api/settings", json={"aitk_path": str(aitk)})
    assert r.status_code == 200, r.text
    return client, aitk


def wait(client, resp):
    """Wait for the background job started by ``resp`` and return its result."""
    import time

    assert resp.status_code == 200, resp.text
    job = resp.json()["job"]
    for _ in range(500):
        job = client.get(f"/api/jobs/{job['id']}").json()
        if job["status"] != "running":
            break
        time.sleep(0.01)
    assert job["status"] == "done", job
    assert job["done"] == job["total"], job
    return job["result"]


def make_img(path: Path, color=(255, 0, 0), size=(4, 2)):
    im = Image.new("RGB", size, (0, 0, 0))
    im.putpixel((0, 0), color)  # marker in top-left
    im.save(path)


def test_settings_default_and_db(env):
    client, aitk = env
    s = client.get("/api/settings").json()
    assert s["source"] == "default"
    assert s["datasets_root"] == str((aitk / "datasets").resolve())
    assert s["aitk_valid"]

    custom = aitk.parent / "my_datasets"
    con = sqlite3.connect(aitk / "aitk_db.db")
    con.execute("CREATE TABLE Settings (id INTEGER PRIMARY KEY, key TEXT UNIQUE, value TEXT)")
    con.execute("INSERT INTO Settings (key, value) VALUES ('DATASETS_FOLDER', ?)", (str(custom),))
    con.commit()
    con.close()
    s = client.get("/api/settings").json()
    assert s["source"] == "aitk_db"
    assert s["datasets_root"] == str(custom.resolve())


def test_crud_and_flip(env):
    client, aitk = env
    assert client.get("/api/datasets").json() == []
    assert client.post("/api/datasets", json={"name": "My Set!"}).json()["name"] == "my_set_"
    root = aitk / "datasets" / "my_set_"

    buf = (Path(__file__).parent / "_tmp.png")
    make_img(buf)
    files = [
        ("files", ("a.png", buf.read_bytes(), "image/png")),
        ("files", ("a.txt", b"a caption", "text/plain")),
        ("files", ("b.png", buf.read_bytes(), "image/png")),
    ]
    buf.unlink()
    assert client.post("/api/datasets/my_set_/upload", files=files).status_code == 200
    items = client.get("/api/datasets/my_set_/items").json()
    assert [i["path"] for i in items] == ["a.png", "b.png"]
    assert items[0]["caption"] == "a caption" and items[1]["caption"] is None

    assert client.put("/api/datasets/my_set_/caption", json={"path": "b.png", "caption": "bee"}).status_code == 200
    assert (root / "b.txt").read_text() == "bee"

    r = wait(client, client.post("/api/datasets/my_set_/flip"))
    assert sorted(r["created"]) == ["a_flip.png", "b_flip.png"]
    with Image.open(root / "a_flip.png") as im:
        assert im.getpixel((3, 0)) == (255, 0, 0) and im.getpixel((0, 0)) == (0, 0, 0)
    assert (root / "a_flip.txt").read_text() == "a caption"
    # Running again doesn't duplicate or flip flips.
    r = wait(client, client.post("/api/datasets/my_set_/flip"))
    assert r["created"] == [] and sorted(r["skipped"]) == ["a.png", "b.png"]

    r = wait(client, client.delete("/api/datasets/my_set_/flip"))
    assert sorted(r["removed"]) == ["a_flip.png", "b_flip.png"]
    assert sorted(p.name for p in root.iterdir()) == ["a.png", "a.txt", "b.png", "b.txt"]

    assert client.get("/api/datasets/my_set_/thumb", params={"path": "a.png", "size": 128}).status_code == 200
    assert client.get("/api/datasets/my_set_/file", params={"path": "../../run.py"}).status_code == 400

    assert wait(client, client.post("/api/datasets/my_set_/delete-items", json={"paths": ["a.png"]}))["deleted"] == 1
    assert not (root / "a.txt").exists()

    assert client.patch("/api/datasets/my_set_", json={"name": "renamed"}).json()["name"] == "renamed"
    assert wait(client, client.delete("/api/datasets/renamed")) is None
    assert client.get("/api/datasets").json() == []


def test_compare_and_delete_unpaired(env):
    client, aitk = env
    for name, stems in {"x": ["1", "2", "3"], "y": ["2", "3", "4", "5"]}.items():
        d = aitk / "datasets" / name
        d.mkdir(parents=True)
        for s in stems:
            make_img(d / f"{s}.jpg" if name == "y" else d / f"{s}.png")
            (d / f"{s}.txt").write_text(s)
    r = client.get("/api/compare", params={"a": "x", "b": "y"}).json()
    assert [p["key"] for p in r["paired"]] == ["2", "3"]
    assert [i["path"] for i in r["only_a"]] == ["1.png"]
    assert [i["path"] for i in r["only_b"]] == ["4.jpg", "5.jpg"]

    r = wait(client, client.post("/api/compare/delete-unpaired", json={"a": "x", "b": "y", "side": "b", "paths_b": ["4.jpg"]}))
    assert r["deleted"] == {"a": 0, "b": 1}
    r = wait(client, client.post("/api/compare/delete-unpaired", json={"a": "x", "b": "y", "side": "both"}))
    assert r["deleted"] == {"a": 1, "b": 1}
    r = client.get("/api/compare", params={"a": "x", "b": "y"}).json()
    assert len(r["paired"]) == 2 and r["only_a"] == [] and r["only_b"] == []


def test_compare_ignores_flips_and_deletes_them(env):
    client, aitk = env
    for name, stems in {"x": ["1", "2", "3"], "y": ["2", "3"]}.items():
        d = aitk / "datasets" / name
        d.mkdir(parents=True)
        for s in stems:
            make_img(d / f"{s}.png")
            (d / f"{s}.txt").write_text(s)
    # Flips: x has 1_flip/2_flip, y has an orphan flip only (4_flip).
    assert len(wait(client, client.post("/api/datasets/x/flip"))["created"]) == 3
    make_img(aitk / "datasets" / "y" / "4_flip.png")

    r = client.get("/api/compare", params={"a": "x", "b": "y"}).json()
    assert [p["key"] for p in r["paired"]] == ["2", "3"]
    assert [i["path"] for i in r["only_a"]] == ["1.png"]
    assert r["only_b"] == []

    r = wait(client, client.post("/api/compare/delete-unpaired", json={"a": "x", "b": "y", "side": "a"}))
    assert r == {"deleted": {"a": 1, "b": 0}, "flips_deleted": {"a": 1, "b": 0}}
    x = aitk / "datasets" / "x"
    assert not (x / "1_flip.png").exists() and not (x / "1_flip.txt").exists()

    r = wait(client, client.post("/api/datasets/x/delete-items", json={"paths": ["2.png"], "with_flips": True}))
    assert r == {"deleted": 1, "flips_deleted": 1}
    assert sorted(p.name for p in x.iterdir()) == ["3.png", "3.txt", "3_flip.png", "3_flip.txt"]

    # Without with_flips (dataset page) the flip stays.
    r = wait(client, client.post("/api/datasets/x/delete-items", json={"paths": ["3.png"]}))
    assert r == {"deleted": 1, "flips_deleted": 0}
    assert (x / "3_flip.png").exists()


def test_rename_dataset(env):
    client, aitk = env
    client.post("/api/datasets", json={"name": "cats"})
    client.post("/api/datasets", json={"name": "dogs"})
    make_img(aitk / "datasets" / "cats" / "a.png")
    # Case, Korean, '-' and '.' are kept; unsafe characters become '_'.
    r = client.patch("/api/datasets/cats", json={"name": "Cats-v2.고양이 / test"})
    assert r.status_code == 200 and r.json()["name"] == "Cats-v2.고양이_test"
    assert (aitk / "datasets" / "Cats-v2.고양이_test" / "a.png").is_file()
    # Case-only rename works.
    assert client.patch("/api/datasets/Cats-v2.고양이_test", json={"name": "CATS-V2.고양이_TEST"}).json()["name"] == "CATS-V2.고양이_TEST"
    assert client.patch("/api/datasets/CATS-V2.고양이_TEST", json={"name": "dogs"}).status_code == 409
    for bad in ["", "..", ".hidden", "///"]:
        assert client.patch("/api/datasets/dogs", json={"name": bad}).status_code == 400, bad
    assert client.patch("/api/datasets/nope", json={"name": "x"}).status_code == 404


def test_duplicate_dataset(env):
    client, aitk = env
    client.post("/api/datasets", json={"name": "src"})
    d = aitk / "datasets" / "src"
    make_img(d / "a.png"); (d / "a.txt").write_text("cap a")
    (d / "_controls").mkdir(); make_img(d / "_controls" / "a.png")
    (d / "_latent_cache").mkdir(); (d / "_latent_cache" / "x.safetensors").write_bytes(b"0")
    (d / ".DS_Store").write_bytes(b"0")
    wait(client, client.post("/api/datasets/src/flip"))

    assert client.get("/api/datasets/src/duplicate-name").json()["name"] == "src_copy"
    r = wait(client, client.post("/api/datasets/src/duplicate", json={"name": "src_copy"}))
    assert r == {"name": "src_copy", "count": 2, "skipped_flips": 0}
    c = aitk / "datasets" / "src_copy"
    assert sorted(p.name for p in c.iterdir()) == ["_controls", "a.png", "a.txt", "a_flip.png", "a_flip.txt"]
    assert (c / "a.txt").read_text() == "cap a"
    assert client.get("/api/datasets/src/duplicate-name").json()["name"] == "src_copy2"

    r = wait(client, client.post("/api/datasets/src/duplicate", json={"name": "no flips", "include_flips": False}))
    assert r == {"name": "no_flips", "count": 1, "skipped_flips": 1}
    assert sorted(p.name for p in (aitk / "datasets" / "no_flips").iterdir()) == ["_controls", "a.png", "a.txt"]

    assert client.post("/api/datasets/src/duplicate", json={"name": "src_copy"}).status_code == 409
    assert client.post("/api/datasets/nope/duplicate", json={"name": "x"}).status_code == 404
    assert not any(p.name.startswith(".") for p in (aitk / "datasets").iterdir())


def test_jobs_progress_cancel_and_lock(env, monkeypatch):
    import threading

    from app import datasets as dsmod

    client, aitk = env
    client.post("/api/datasets", json={"name": "big"})
    d = aitk / "datasets" / "big"
    for i in range(5):
        make_img(d / f"{i}.png")

    gate = threading.Event()
    real_flip = dsmod.flip_image

    def slow_flip(src, dst):
        gate.wait(5)
        real_flip(src, dst)

    monkeypatch.setattr(dsmod, "flip_image", slow_flip)
    job = client.post("/api/datasets/big/flip").json()["job"]
    assert job["status"] == "running"
    # Second job on the same dataset is refused while the first runs; rename too.
    r = client.delete("/api/datasets/big/flip")
    assert r.status_code == 409 and "진행 중" in r.json()["detail"]
    assert client.patch("/api/datasets/big", json={"name": "other"}).status_code == 409
    assert [j["id"] for j in client.get("/api/jobs", params={"active": True}).json()] == [job["id"]]
    j = client.get(f"/api/jobs/{job['id']}").json()
    assert j["total"] == 5 and j["current"] == "0.png"

    client.post(f"/api/jobs/{job['id']}/cancel")
    gate.set()
    import time
    for _ in range(300):
        j = client.get(f"/api/jobs/{job['id']}").json()
        if j["status"] != "running":
            break
        time.sleep(0.01)
    assert j["status"] == "cancelled" and j["done"] < 5
    assert client.get("/api/jobs", params={"active": True}).json() == []


def test_delete_with_flips_both_directions(env):
    client, aitk = env
    client.post("/api/datasets", json={"name": "fl"})
    d = aitk / "datasets" / "fl"
    for n in "abc":
        make_img(d / f"{n}.png"); (d / f"{n}.txt").write_text(n)
    wait(client, client.post("/api/datasets/fl/flip"))

    # original -> its flip goes too
    r = wait(client, client.post("/api/datasets/fl/delete-items", json={"paths": ["a.png"], "with_flips": True}))
    assert r == {"deleted": 1, "flips_deleted": 1}
    # flip -> its original goes too
    r = wait(client, client.post("/api/datasets/fl/delete-items", json={"paths": ["b_flip.png"], "with_flips": True}))
    assert r == {"deleted": 1, "flips_deleted": 1}
    # selecting both of a pair is not double counted
    r = wait(client, client.post("/api/datasets/fl/delete-items", json={"paths": ["c.png", "c_flip.png"], "with_flips": True}))
    assert r == {"deleted": 2, "flips_deleted": 0}
    assert list(d.iterdir()) == []
