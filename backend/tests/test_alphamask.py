import numpy as np
from PIL import Image, ImageDraw

from .test_api import env, wait  # noqa: F401  (fixture + job helper)


def test_alpha_mask_dataset(env):
    client, aitk = env
    d = aitk / "datasets" / "cut"
    (d / "sub").mkdir(parents=True)
    im = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((10, 5, 29, 24), fill=(200, 50, 50, 255))
    im.putpixel((0, 0), (0, 0, 0, 10))  # below threshold -> not opaque
    im.save(d / "a.png")
    (d / "a.txt").write_text("cap")
    im.save(d / "sub" / "b.webp", lossless=True)
    Image.new("RGB", (8, 8), (9, 9, 9)).save(d / "solid.jpg")  # no alpha -> all white
    Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(d / "clear.png")  # all transparent -> all black
    wait(client, client.post("/api/datasets/cut/flip"))

    info = client.get("/api/datasets/cut/alpha-mask/info").json()
    assert info["images"] == 8 and info["flips"] == 4

    r = wait(client, client.post("/api/datasets/cut/alpha-mask", json={"name": "cut_masks", "include_flips": False}))
    assert r["made"] == 4 and r["no_alpha"] == ["solid.jpg"] and r["empty"] == ["clear.png"]
    out = aitk / "datasets" / "cut_masks"
    assert sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()) == [
        "a.png", "clear.png", "solid.png", "sub/b.png"]
    m = np.asarray(Image.open(out / "a.png"))
    assert m.dtype == np.uint8 and m.shape == (30, 40)
    assert (m[5:25, 10:30] == 255).all() and m.sum() == 255 * 20 * 20  # exactly the opaque square
    assert np.asarray(Image.open(out / "solid.png")).min() == 255
    assert np.asarray(Image.open(out / "clear.png")).max() == 0

    # grow/shrink + flips + preview dataset
    r = wait(client, client.post("/api/datasets/cut/alpha-mask", json={
        "name": "grown", "preview_name": "grown_preview", "grow_px": 2}))
    assert r["made"] == 8 and (aitk / "datasets" / "grown_preview" / "a_flip.png").is_file()
    assert np.asarray(Image.open(aitk / "datasets" / "grown" / "a.png")).sum() == 255 * 24 * 24
    r = wait(client, client.post("/api/datasets/cut/alpha-mask", json={"name": "shrunk", "grow_px": -2, "include_flips": False}))
    assert np.asarray(Image.open(aitk / "datasets" / "shrunk" / "a.png")).sum() == 255 * 16 * 16

    res = client.post("/api/datasets/cut/alpha-mask/preview", json={"path": "a.png"})
    assert res.status_code == 200 and res.headers["x-mask-has-alpha"] == "1"
    assert abs(float(res.headers["x-mask-cover"]) - 400 / 1200 * 100) < 0.1
    assert client.post("/api/datasets/cut/alpha-mask", json={"name": "cut_masks"}).status_code == 409
    assert client.post("/api/datasets/cut/alpha-mask", json={"name": "x", "preview_name": "x"}).status_code == 400
