from .test_api import env, make_img, wait  # noqa: F401


def test_batch_captions(env):
    client, aitk = env
    d = aitk / "datasets" / "cap"
    d.mkdir(parents=True)
    for n, cap in [("a", "a red house"), ("b", ""), ("c", None), ("d", "sks, a Red door")]:
        make_img(d / f"{n}.png")
        if cap is not None:
            (d / f"{n}.txt").write_text(cap)
    wait(client, client.post("/api/datasets/cap/flip"))  # flips copy captions
    read = lambda n: (d / f"{n}.txt").read_text() if (d / f"{n}.txt").exists() else None  # noqa: E731
    run = lambda paths, op, **kw: client.post("/api/datasets/cap/captions/batch", json={"paths": paths, "op": op, **kw})  # noqa: E731

    # prepend a trigger word; skip where it already exists; linked flips follow
    r = run(["a.png", "b.png", "c.png", "d.png"], {"mode": "prepend", "text": "sks"}, dry_run=True).json()
    assert r["targets"] == 8 and r["changed"] == 6
    assert {c["path"]: c["after"] for c in r["changes"]}["a.png"] == "sks, a red house"
    assert read("a") == "a red house"  # dry run
    assert run(["a.png", "b.png", "c.png", "d.png"], {"mode": "prepend", "text": "sks"}).json() == {"targets": 8, "changed": 6}
    assert read("a") == "sks, a red house" and read("a_flip") == "sks, a red house"
    assert read("b") == "sks" and read("c") == "sks" and read("d") == "sks, a Red door"

    # append with custom separator, no linked
    run(["a.png"], {"mode": "append", "text": "photo", "separator": ". "}, include_linked=False)
    assert read("a") == "sks, a red house. photo" and read("a_flip") == "sks, a red house"

    # find/replace (case-insensitive), literal (no regex)
    run(["a.png", "d.png"], {"mode": "replace", "find": "red", "replace_with": "blue", "ignore_case": True})
    assert read("a") == "sks, a blue house. photo" and read("d") == "sks, a blue door" and read("d_flip") == "sks, a blue door"
    run(["a.png"], {"mode": "replace", "find": ".", "replace_with": ","}, include_linked=False)
    assert read("a") == "sks, a blue house, photo"

    # set only where empty, then set all, then clear
    (d / "b.txt").write_text("")
    r = run(["a.png", "b.png"], {"mode": "set", "text": "new", "only_empty": True}, include_linked=False).json()
    assert r["changed"] == 1 and read("b") == "new" and read("a").startswith("sks")
    run(["a.png"], {"mode": "set", "text": "only this"})
    assert read("a") == "only this" and read("a_flip") == "only this"
    run(["a.png"], {"mode": "clear"})
    assert read("a") == "" and read("a_flip") == ""

    assert run(["a.png"], {"mode": "prepend", "text": "  "}).status_code == 400
    assert run(["a.png"], {"mode": "replace", "find": ""}).status_code == 400
