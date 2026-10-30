from .test_api import env, make_img, wait  # noqa: F401


def _ds(aitk, name, files):
    d = aitk / "datasets" / name
    d.mkdir(parents=True)
    for f in files:
        (d / f).parent.mkdir(parents=True, exist_ok=True)
        make_img(d / f"{f}.png")
        (d / f"{f}.txt").write_text(f"{name}:{f}")
    return d


def listing(d):
    return sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())


def test_merge_datasets(env):
    client, aitk = env
    _ds(aitk, "x", ["a", "a_flip", "b", "sub/c"])
    _ds(aitk, "y", ["a", "a_flip", "d"])
    (aitk / "datasets" / "x" / "_latent_cache").mkdir()
    (aitk / "datasets" / "x" / "_latent_cache" / "z.png").write_bytes(b"")

    r = client.post("/api/datasets-merge", json={"sources": ["x", "y"], "dry_run": True}).json()
    assert r["items"] == 7 and r["conflicts"] == ["a"] and r["conflict_count"] == 1 and r["clashes"] == []
    assert r["per_source"] == {"x": 4, "y": 3}

    r = wait(client, client.post("/api/datasets-merge", json={"sources": ["x", "y"], "name": "m1"}))
    assert r == {"name": "m1", "items": 7, "captions": 7, "conflicts": 1, "skipped": 0}
    m1 = aitk / "datasets" / "m1"
    assert listing(m1) == [
        "b.png", "b.txt", "d.png", "d.txt", "sub/c.png", "sub/c.txt",
        "x_a.png", "x_a.txt", "x_a_flip.png", "x_a_flip.txt", "y_a.png", "y_a.txt", "y_a_flip.png", "y_a_flip.txt"]
    assert (m1 / "y_a_flip.txt").read_text() == "y:a_flip"

    r = wait(client, client.post("/api/datasets-merge", json={"sources": ["y", "x"], "name": "m2", "strategy": "skip"}))
    assert r["items"] == 5 and r["skipped"] == 2
    assert (aitk / "datasets" / "m2" / "a.txt").read_text() == "y:a"  # first source wins

    r = wait(client, client.post("/api/datasets-merge", json={
        "sources": ["x", "y"], "name": "m3", "strategy": "prefix_all", "include_flips": False}))
    assert listing(aitk / "datasets" / "m3") == [
        "sub/x_c.png", "sub/x_c.txt", "x_a.png", "x_a.txt", "x_b.png", "x_b.txt", "y_a.png", "y_a.txt", "y_d.png", "y_d.txt"]

    assert client.post("/api/datasets-merge", json={"sources": ["x", "y"], "name": "m1"}).status_code == 409
    assert client.post("/api/datasets-merge", json={"sources": ["x"], "name": "m9"}).status_code == 400
    assert client.post("/api/datasets-merge", json={"sources": ["x", "nope"], "name": "m9"}).status_code == 404
    assert not (aitk / "datasets" / "m9").exists()
