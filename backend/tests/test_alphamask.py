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


def test_alpha_mask_colors(env):
    client, aitk = env
    d = aitk / "datasets" / "colr"
    d.mkdir(parents=True)
    im = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((2, 2, 5, 5), fill=(9, 9, 9, 255))
    im.save(d / "a.png")

    # default stays a grayscale white/black mask
    wait(client, client.post("/api/datasets/colr/alpha-mask", json={"name": "m_default"}))
    with Image.open(aitk / "datasets" / "m_default" / "a.png") as m:
        assert m.mode == "L" and m.getpixel((3, 3)) == 255 and m.getpixel((0, 0)) == 0

    # opaque colours -> RGB
    wait(client, client.post("/api/datasets/colr/alpha-mask", json={
        "name": "m_rgb", "opaque_color": "#ff0000", "transparent_color": "#0000ffff"}))
    with Image.open(aitk / "datasets" / "m_rgb" / "a.png") as m:
        assert m.mode == "RGB" and m.getpixel((3, 3)) == (255, 0, 0) and m.getpixel((0, 0)) == (0, 0, 255)

    # transparency in a colour -> RGBA, e.g. white on fully transparent
    wait(client, client.post("/api/datasets/colr/alpha-mask", json={
        "name": "m_rgba", "opaque_color": "#ffffff80", "transparent_color": "#00000000", "preview_name": "m_rgba_prev"}))
    with Image.open(aitk / "datasets" / "m_rgba" / "a.png") as m:
        assert m.mode == "RGBA" and m.getpixel((3, 3)) == (255, 255, 255, 128) and m.getpixel((0, 0)) == (0, 0, 0, 0)
    assert (aitk / "datasets" / "m_rgba_prev" / "a.png").is_file()

    res = client.post("/api/datasets/colr/alpha-mask/preview", json={"path": "a.png", "opaque_color": "#00ff00cc"})
    assert res.status_code == 200
    bad = client.post("/api/datasets/colr/alpha-mask", json={"name": "m_bad", "opaque_color": "red"})
    assert bad.status_code == 400 and not (aitk / "datasets" / "m_bad").exists()
    assert client.post("/api/datasets/colr/alpha-mask/preview", json={"path": "a.png", "transparent_color": "#12"}).status_code == 400
