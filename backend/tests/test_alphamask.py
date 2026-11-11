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


def test_alpha_mask_edge_only(env):
    client, aitk = env
    d = aitk / "datasets" / "edge"
    d.mkdir(parents=True)
    im = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((5, 5, 14, 14), fill=(9, 9, 9, 255))  # 10x10 opaque square
    im.save(d / "a.png")
    on = lambda n: np.asarray(Image.open(aitk / "datasets" / n / "a.png")) > 127  # noqa: E731

    # inside: 2px band inside the square (10x10 minus 6x6)
    wait(client, client.post("/api/datasets/edge/alpha-mask", json={"name": "e_in", "edge_px": 2}))
    m = on("e_in")
    assert m.sum() == 100 - 36 and m[5, 5] and m[6, 9] and not m[7, 7] and not m[4, 9]

    # outside: 2px ring around it (14x14 minus 10x10)
    wait(client, client.post("/api/datasets/edge/alpha-mask", json={"name": "e_out", "edge_px": 2, "edge_pos": "outside"}))
    m = on("e_out")
    assert m.sum() == 196 - 100 and m[3, 9] and m[4, 9] and not m[5, 9]

    # centre: 1px outside + 1px inside (12x12 minus 8x8)
    wait(client, client.post("/api/datasets/edge/alpha-mask", json={"name": "e_mid", "edge_px": 2, "edge_pos": "center"}))
    m = on("e_mid")
    assert m.sum() == 144 - 64 and m[4, 9] and m[5, 9] and not m[6, 9] and not m[3, 9]

    # colours still apply: edge red, rest transparent
    wait(client, client.post("/api/datasets/edge/alpha-mask", json={
        "name": "e_col", "edge_px": 1, "opaque_color": "#ff0000", "transparent_color": "#00000000"}))
    with Image.open(aitk / "datasets" / "e_col" / "a.png") as m:
        assert m.mode == "RGBA" and m.getpixel((5, 9)) == (255, 0, 0, 255) and m.getpixel((9, 9)) == (0, 0, 0, 0)

    res = client.post("/api/datasets/edge/alpha-mask/preview", json={"path": "a.png", "edge_px": 2})
    assert res.status_code == 200 and abs(float(res.headers["x-mask-cover"]) - 64 / 400 * 100) < 0.1
    assert client.post("/api/datasets/edge/alpha-mask", json={"name": "e_bad", "edge_px": 2, "edge_pos": "middle"}).status_code == 422


def test_alpha_mask_overlay_output(env):
    client, aitk = env
    d = aitk / "datasets" / "ovl"
    d.mkdir(parents=True)
    im = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((2, 2, 7, 7), fill=(0, 0, 200, 255))  # blue square on transparent
    im.save(d / "a.png")
    r = wait(client, client.post("/api/datasets/ovl/alpha-mask", json={
        "name": "ovl_m", "overlay_name": "ovl_m_overlay", "overlay_opacity": 0.5,
        "opaque_color": "#ff0000", "transparent_color": "#00000000"}))
    assert r["overlay"] == "ovl_m_overlay"
    with Image.open(aitk / "datasets" / "ovl_m_overlay" / "a.png") as o:
        assert o.mode == "RGBA"  # source had transparency
        assert o.getpixel((0, 0)) == (0, 0, 0, 0)  # transparent mask colour leaves the source
        r_, g_, b_, a_ = o.getpixel((4, 4))  # 50% red over blue
        assert a_ == 255 and abs(r_ - 128) <= 2 and abs(b_ - 100) <= 2
    res = client.post("/api/datasets/ovl/alpha-mask/preview", json={"path": "a.png", "overlay_opacity": 0.5})
    with Image.open(__import__("io").BytesIO(res.content)) as p:
        assert p.size == (30, 10)  # source | mask | overlay
    # name clashes between outputs are refused
    assert client.post("/api/datasets/ovl/alpha-mask", json={"name": "x1", "overlay_name": "x1"}).status_code == 400
