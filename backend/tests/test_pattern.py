import numpy as np
from PIL import Image, ImageDraw

from .test_api import env, make_img, wait  # noqa: F401


def spec(**kw):
    # 2x2 tile: red, transparent / blue, white
    s = {"w": 2, "h": 2, "cell": 3, "pixels": ["#ff0000", "", "#0000FF", "#ffffff"]}
    s.update(kw)
    return s


def test_pattern_render_save_unique_and_flip(env):
    client, aitk = env
    d = aitk / "datasets" / "bld"
    d.mkdir(parents=True)
    im = Image.new("RGBA", (20, 12), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((5, 2, 16, 11), fill=(250, 250, 250, 255))  # building bbox (5,2)-(17,12)
    im.save(d / "a.png"); im.save(d / "b.png"); im.save(d / "c.png")
    wait(client, client.post("/api/datasets/bld/flip"))

    t = client.get("/api/datasets/bld/patterns/target", params={"path": "a.png"}).json()
    assert t == {"width": 20, "height": 12, "bbox": [5, 2, 17, 12], "spec": None, "mirrored": False}
    assert client.get("/api/datasets/bld/patterns").json()["exists"] is False

    r = client.put("/api/datasets/bld/patterns", json={"path": "a.png", "spec": spec()})
    assert r.status_code == 200, r.text
    assert r.json() == {"dataset": "bld_pattern", "written": ["a.png", "a_flip.png"]}
    out = aitk / "datasets" / "bld_pattern"
    g = np.asarray(Image.open(out / "a.png"))
    assert g.shape == (12, 20, 4)
    assert tuple(g[0, 0]) == (255, 0, 0, 255) and tuple(g[2, 2]) == (255, 0, 0, 255)  # cell 3
    assert g[0, 3, 3] == 0  # transparent tile pixel
    assert tuple(g[3, 0]) == (0, 0, 255, 255) and tuple(g[3, 3]) == (255, 255, 255, 255)
    assert tuple(g[6, 6]) == (255, 0, 0, 255)  # repeats every 6px
    # flip copy gets the mirrored guide
    assert (np.asarray(Image.open(out / "a_flip.png")) == g[:, ::-1]).all()

    # bbox anchor + offset + clip, background colour
    s2 = spec(anchor="bbox", offset_x=1, clip="opaque", background="#000000")
    client.put("/api/datasets/bld/patterns", json={"path": "b.png", "spec": s2})
    g2 = np.asarray(Image.open(out / "b.png"))
    assert g2[0, 0, 3] == 0  # outside the building: clipped
    assert tuple(g2[2, 6]) == (255, 0, 0, 255)  # origin = bbox (5,2) + offset 1
    assert tuple(g2[2, 9]) == (0, 0, 0, 255)  # transparent tile pixel -> background

    # same spec as a -> one unique entry with count 2
    client.put("/api/datasets/bld/patterns", json={"path": "c.png", "spec": spec()})
    lst = client.get("/api/datasets/bld/patterns").json()
    assert lst["exists"] and set(lst["items"]) == {"a", "a_flip", "b", "b_flip", "c", "c_flip"}
    assert [u["count"] for u in lst["unique"]] == [2, 1]
    assert lst["unique"][0]["keys"] == ["a", "c"] and lst["unique"][0]["spec"]["pixels"][2] == "#0000ff"
    assert client.get("/api/datasets/bld/patterns/target", params={"path": "c.png"}).json()["spec"]["cell"] == 3
    assert client.get("/api/datasets/bld/patterns/target", params={"path": "c_flip.png"}).json()["mirrored"] is True

    # delete removes the item and its mirrored flip guide
    assert client.delete("/api/datasets/bld/patterns", params={"path": "c.png"}).json() == {"removed": ["c.png", "c_flip.png"]}
    assert [u["count"] for u in client.get("/api/datasets/bld/patterns").json()["unique"]] == [1, 1]

    bad = client.put("/api/datasets/bld/patterns", json={"path": "a.png", "spec": spec(pixels=["#ff0000"])})
    assert bad.status_code == 422
    assert client.put("/api/datasets/bld/patterns", json={"path": "nope.png", "spec": spec()}).status_code == 404
