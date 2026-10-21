import numpy as np
from PIL import Image, ImageDraw

from .test_api import env, wait  # noqa: F401  (fixture + job helper)


def building(size=(160, 120), painted=False, seed=0):
    """White building on a transparent background; 'painted' adds coloured wall stripes + specks."""
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((20, 20, size[0] - 20, size[1] - 10), fill=(250, 250, 250, 255))
    if painted:
        for y in range(30, size[1] - 20, 6):  # stripes with 2px gaps
            d.rectangle((30, y, size[0] - 40, y + 3), fill=(180, 60, 40, 255))
        rng = np.random.default_rng(seed)
        for x, y in rng.integers(25, 100, size=(6, 2)):
            d.point((int(x), int(y)), fill=(0, 0, 0, 255))
    return im


def make_sets(root):
    t, c = root / "tgt", root / "ctl"
    t.mkdir(parents=True); c.mkdir(parents=True)
    for i in range(3):
        building(painted=True, seed=i).save(t / f"b{i}.png")
        building().save(c / f"b{i}.png")
    building(painted=True).save(t / "big.png")
    building(size=(80, 60)).save(c / "big.png")  # control smaller -> resized
    building(painted=True).save(t / "no_ctl.png")
    building().save(c / "only_ctl.png")
    return t, c


def test_matches_original_script(env, tmp_path):
    import importlib.util, os, sys
    client, aitk = env
    t, c = make_sets(aitk / "datasets")

    r = wait(client, client.post("/api/compare/masks", json={
        "target": "tgt", "control": "ctl", "name": "tgt_masks", "preview_name": "tgt_masks_preview"}))
    assert r["made"] == 5 and r["only_target"] == ["no_ctl"] and r["only_control"] == ["only_ctl"]
    assert any(w["key"] == "big" and "리사이즈" in w["notes"][0] for w in r["warnings"])
    out = aitk / "datasets" / "tgt_masks"
    assert sorted(p.name for p in out.iterdir()) == ["b0.png", "b1.png", "b2.png", "big.png", "no_ctl.png"]
    assert (aitk / "datasets" / "tgt_masks_preview" / "b0.png").is_file()

    # With WALLMASK_SCRIPT=<path to make_wall_masks.py>, run the original script with default
    # options on the same folders and compare pixel for pixel.
    script = os.environ.get("WALLMASK_SCRIPT")
    if script:
        spec = importlib.util.spec_from_file_location("mwm", script)
        mwm = importlib.util.module_from_spec(spec); spec.loader.exec_module(mwm)
        ref = tmp_path / "ref"
        sys_argv = sys.argv
        sys.argv = ["x", "--target", str(t), "--control", str(c), "--out", str(ref)]
        try:
            mwm.main()
        finally:
            sys.argv = sys_argv
        for p in ref.iterdir():
            a = np.asarray(Image.open(p)); b = np.asarray(Image.open(out / p.name))
            assert a.shape == b.shape and (a == b).all(), p.name
        print(f"identical to original script: {sorted(p.name for p in ref.iterdir())}")
    assert np.asarray(Image.open(out / "b0.png")).max() == 255  # wall found

    # skip mode + preview endpoint
    r = wait(client, client.post("/api/compare/masks", json={
        "target": "tgt", "control": "ctl", "name": "m2", "params": {"no_control": "skip"}}))
    assert r["made"] == 4 and not (aitk / "datasets" / "m2" / "no_ctl.png").exists()
    res = client.post("/api/compare/masks/preview", json={"target": "tgt", "control": "ctl", "key": "b0"})
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    assert float(res.headers["x-mask-cover"]) > 3
    info = client.post("/api/compare/masks/info", json={"target": "tgt", "control": "ctl"}).json()
    assert info["pairs"] == 4 and info["targets"] == 5
    assert client.post("/api/compare/masks", json={"target": "tgt", "control": "ctl", "name": "tgt_masks"}).status_code == 409
