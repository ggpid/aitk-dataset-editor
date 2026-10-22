import json

import numpy as np
from PIL import Image, PngImagePlugin

from .test_api import env, wait  # noqa: F401


def spec(**kw):
    # 2x2 tile: red, empty(=white) / blue, gray
    s = {"w": 2, "h": 2, "pixels": ["#ff0000", "", "#0000FF", "#666666"], "out_w": 10, "out_h": 6}
    s.update(kw)
    return s


def test_pattern_stretch_save_unique_and_flip(env):
    client, aitk = env
    d = aitk / "datasets" / "bld"
    d.mkdir(parents=True)
    for n in "abc":
        Image.new("RGBA", (20, 12), (0, 0, 0, 0)).save(d / f"{n}.png")
    wait(client, client.post("/api/datasets/bld/flip"))

    t = client.get("/api/datasets/bld/patterns/target", params={"path": "a.png"}).json()
    assert t == {"width": 20, "height": 12, "spec": None, "mirrored": False}
    lst = client.get("/api/datasets/bld/patterns").json()
    assert lst["exists"] is False and lst["common_size"] is None

    r = client.put("/api/datasets/bld/patterns", json={"path": "a.png", "spec": spec()})
    assert r.status_code == 200, r.text
    assert r.json() == {"dataset": "bld_pattern", "written": ["a.png", "a_flip.png"]}
    out = aitk / "datasets" / "bld_pattern"
    g = np.asarray(Image.open(out / "a.png"))
    # stretched (not tiled) to the output size, empty cells white, no alpha
    assert g.shape == (6, 10, 3)
    assert tuple(g[0, 0]) == (255, 0, 0) and tuple(g[2, 4]) == (255, 0, 0)
    assert tuple(g[0, 5]) == (255, 255, 255) and tuple(g[2, 9]) == (255, 255, 255)
    assert tuple(g[3, 0]) == (0, 0, 255) and tuple(g[5, 9]) == (102, 102, 102)
    assert (np.asarray(Image.open(out / "a_flip.png")) == g[:, ::-1]).all()

    # same tile, different output size -> still one unique pattern
    client.put("/api/datasets/bld/patterns", json={"path": "b.png", "spec": spec(out_w=4, out_h=4)})
    client.put("/api/datasets/bld/patterns", json={"path": "c.png", "spec": spec(pixels=["#ffffff"] * 4)})
    lst = client.get("/api/datasets/bld/patterns").json()
    assert set(lst["items"]) == {"a", "a_flip", "b", "b_flip", "c", "c_flip"}
    assert [u["count"] for u in lst["unique"]] == [2, 1]
    assert lst["unique"][0]["keys"] == ["a", "b"] and lst["unique"][0]["spec"]["pixels"][1] == "#ffffff"
    assert lst["common_size"] == [10, 6]
    assert np.asarray(Image.open(out / "b.png")).shape == (4, 4, 3)
    got = client.get("/api/datasets/bld/patterns/target", params={"path": "b.png"}).json()
    assert got["spec"]["out_w"] == 4 and got["mirrored"] is False
    assert client.get("/api/datasets/bld/patterns/target", params={"path": "b_flip.png"}).json()["mirrored"] is True

    # v1 file (no output size) is still readable: size taken from the PNG
    info = PngImagePlugin.PngInfo()
    info.add_text("aitk_pattern", json.dumps({"spec": {"w": 1, "h": 1, "pixels": ["#ff0000"], "cell": 8}, "mirrored": False}))
    Image.new("RGB", (7, 5)).save(out / "c.png", pnginfo=info)
    assert client.get("/api/datasets/bld/patterns/target", params={"path": "c.png"}).json()["spec"]["out_w"] == 7

    assert client.delete("/api/datasets/bld/patterns", params={"path": "c.png"}).json() == {"removed": ["c.png", "c_flip.png"]}
    assert client.put("/api/datasets/bld/patterns", json={"path": "a.png", "spec": spec(pixels=["#ff0000"])}).status_code == 422
    assert client.put("/api/datasets/bld/patterns", json={"path": "a.png", "spec": spec(out_w=0)}).status_code == 422
    assert client.put("/api/datasets/bld/patterns", json={"path": "nope.png", "spec": spec()}).status_code == 404
