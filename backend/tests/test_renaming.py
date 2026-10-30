from PIL import Image

from .test_api import env, make_img, wait  # noqa: F401


def test_prefix_suffix_rename(env):
    client, aitk = env
    d = aitk / "datasets" / "rn"
    (d / "sub").mkdir(parents=True)
    for n in ["a", "b", "sub/c"]:
        make_img(d / f"{n}.png")
        (d / f"{n}.txt").write_text(n)
    wait(client, client.post("/api/datasets/rn/flip"))
    spec = {"w": 1, "h": 1, "pixels": ["#ffffff"], "out_w": 4, "out_h": 4}
    assert client.put("/api/datasets/rn/patterns", json={"path": "a.png", "spec": spec}).status_code == 200

    # dry run: originals only selected; flips + caption + patterns come along
    r = client.post("/api/datasets/rn/rename-items", json={
        "paths": ["a.png", "sub/c.png"], "prefix": "p_", "suffix": "_v2", "dry_run": True}).json()
    assert {x["from"]: x["to"] for x in r["renames"]} == {
        "a.png": "p_a_v2.png", "sub/c.png": "sub/p_c_v2.png",
        "a_flip.png": "p_a_v2_flip.png", "sub/c_flip.png": "sub/p_c_v2_flip.png"}
    assert r["linked"] == 2 and r["captions"] == 4 and r["patterns"] == 2 and r["conflicts"] == [] and r["total"] == 4
    assert (d / "a.png").exists()  # dry run changes nothing

    r = client.post("/api/datasets/rn/rename-items", json={"paths": ["a.png", "sub/c.png"], "prefix": "p_", "suffix": "_v2"})
    assert r.status_code == 200 and r.json()["renamed"] == 4
    names = sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())
    assert names == ["b.png", "b.txt", "b_flip.png", "b_flip.txt", "p_a_v2.png", "p_a_v2.txt", "p_a_v2_flip.png",
                     "p_a_v2_flip.txt", "sub/p_c_v2.png", "sub/p_c_v2.txt", "sub/p_c_v2_flip.png", "sub/p_c_v2_flip.txt"]
    assert (d / "p_a_v2.txt").read_text() == "a"
    pat = aitk / "datasets" / "rn_pattern"
    assert sorted(p.name for p in pat.iterdir()) == ["p_a_v2.png", "p_a_v2_flip.png"]
    assert set(client.get("/api/datasets/rn/patterns").json()["items"]) == {"p_a_v2", "p_a_v2_flip"}

    # conflict: nothing renamed
    make_img(d / "x_b.png")
    r = client.post("/api/datasets/rn/rename-items", json={"paths": ["b.png"], "prefix": "x_", "include_linked": False})
    assert r.status_code == 409 and (d / "b.png").exists()
    # flip selected alone -> original comes along, suffix stays before _flip
    r = client.post("/api/datasets/rn/rename-items", json={"paths": ["b_flip.png"], "suffix": "-2"}).json()
    assert r["renamed"] == 2 and (d / "b-2.png").exists() and (d / "b-2_flip.png").exists()
    # validation
    assert client.post("/api/datasets/rn/rename-items", json={"paths": ["b-2.png"], "prefix": "a/b"}).status_code == 400
    assert client.post("/api/datasets/rn/rename-items", json={"paths": ["b-2.png"]}).status_code == 400
    assert not [p for p in d.rglob("*") if p.name.startswith(".")]  # no temp files left
