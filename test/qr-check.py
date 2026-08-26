#!/usr/bin/env python3
"""Check js/qr.js against two independent implementations and a real decoder.

The label app cannot load a QR library from a CDN, so the encoder is written by
hand — which means it has to be held to someone else's standard rather than its
own. Three checks, run over the same sweep of payloads:

  1. matrix equality with python-qrcode, at a fixed version, error level and
     mask, so nothing is hidden by a different choice of mask;
  2. penalty-score equality with segno, computed on the identical matrix, which
     is what decides the mask when the app chooses one itself;
  3. a round trip through zxingcpp, the decoder a scanner would agree with.

One deliberate difference is worth knowing about. Which mask the encoder picks
when left to itself does not always agree with either library: the standard's
Table 11 does not say whether the format information is present while the masks
are being scored, and implementations read it both ways. Any of the eight masks
produces a valid symbol, so this changes which of eight correct answers gets
printed and nothing else. Check 1 pins a mask precisely so that this freedom
cannot mask a real fault.

    pip install segno qrcode zxing-cpp
    python3 test/qr-check.py
"""
import json, os, random, string, subprocess, sys, tempfile

import numpy as np
import qrcode
import segno
import segno.encoder
import zxingcpp
from qrcode.constants import (ERROR_CORRECT_H, ERROR_CORRECT_L,
                              ERROR_CORRECT_M, ERROR_CORRECT_Q)

HERE = os.path.dirname(os.path.abspath(__file__))
QRJS = os.path.join(HERE, os.pardir, "js", "qr.js")
EC = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}
MODE = {"numeric": "numeric", "alnum": "alphanumeric", "byte": "byte"}
ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"


def pick_mode(t):
    if all(c in string.digits for c in t):
        return "numeric"
    if all(c in ALNUM for c in t):
        return "alnum"
    return "byte"


def payloads():
    random.seed(7)
    out = [
        "39012473", "39012473\n",                    # what a label actually carries
        "1", "12", "123",
        "AllJoy Chicken Gizzard", "AllJoy Chicken Gizzard 250g",
        "HELLO WORLD", "ABC-123/456:789",
        "https://meatplus.ph/t/39012473",
        "Meatplus — Ángel ñ 中文 test",                # forces UTF-8 byte mode
    ]
    for n in (5, 17, 33, 64, 120, 300, 700):
        out.append("".join(random.choice(string.digits) for _ in range(n)))
        out.append("".join(random.choice(ALNUM) for _ in range(n)))
        out.append("".join(random.choice(string.printable[:94]) for _ in range(n)))
    return out


def build_cases():
    cases = []
    for text in payloads():
        mode = pick_mode(text)
        for ec in "LMQH":
            try:
                probe = segno.make(text, error=ec, mode=MODE[mode], boost_error=False)
            except Exception:
                continue
            ver = probe.version
            if not isinstance(ver, int) or ver > 20:
                continue
            for mask in range(8):
                cases.append({"text": text, "ec": ec, "ver": ver, "mask": mask})
    return cases


def run_encoder(cases, workdir):
    """Drive js/qr.js under node and bring the matrices back as strings of 0/1."""
    cpath = os.path.join(workdir, "cases.json")
    opath = os.path.join(workdir, "out.json")
    with open(cpath, "w") as fh:
        json.dump(cases, fh)
    script = """
      const fs = require('fs');
      const src = fs.readFileSync(%s, 'utf8');
      const mod = { exports: {} };
      new Function('module', 'exports', src + '\\nmodule.exports={qrEncode,qrPenalty};')(mod, mod.exports);
      const { qrEncode, qrPenalty } = mod.exports;
      const cases = JSON.parse(fs.readFileSync(%s, 'utf8'));
      fs.writeFileSync(%s, JSON.stringify(cases.map(c => {
        const r = qrEncode(c.text, { ec: c.ec, minVersion: c.ver, maxVersion: c.ver, mask: c.mask });
        return { rows: r.modules.map(row => row.join('')), score: qrPenalty(r.modules), mode: r.mode };
      })));
    """ % (json.dumps(QRJS), json.dumps(cpath), json.dumps(opath))
    subprocess.run(["node", "-e", script], check=True)
    with open(opath) as fh:
        return json.load(fh)


def to_image(rows, scale=4, quiet=4):
    n = len(rows)
    side = (n + quiet * 2) * scale
    im = np.full((side, side), 255, np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "1":
                im[(y + quiet) * scale:(y + quiet + 1) * scale,
                   (x + quiet) * scale:(x + quiet + 1) * scale] = 0
    return im


def main():
    cases = build_cases()
    with tempfile.TemporaryDirectory() as workdir:
        mine = run_encoder(cases, workdir)

    matrix_bad, penalty_bad, decode_bad = [], [], []
    for case, got in zip(cases, mine):
        ref = qrcode.QRCode(version=case["ver"], error_correction=EC[case["ec"]],
                            box_size=1, border=0, mask_pattern=case["mask"])
        ref.add_data(case["text"], optimize=0)
        ref.make(fit=False)
        ref_rows = ["".join("1" if v else "0" for v in row) for row in ref.modules]
        if ref_rows != got["rows"]:
            matrix_bad.append(case)

        grid = [bytearray(int(ch) for ch in row) for row in got["rows"]]
        size = len(grid)
        if segno.encoder.evaluate_mask(grid, size, size) != got["score"]:
            penalty_bad.append(case)

        read = zxingcpp.read_barcode(to_image(got["rows"]))
        if not read or read.text != case["text"]:
            decode_bad.append(case)

    def report(name, bad):
        mark = "PASS" if not bad else "FAIL"
        print("%s  %-38s %d/%d" % (mark, name, len(cases) - len(bad), len(cases)))
        for case in bad[:5]:
            print("        ec=%s v=%s mask=%s  %r" % (case["ec"], case["ver"], case["mask"], case["text"][:30]))
        return not bad

    print("QR encoder — %d payload/level/mask combinations\n" % len(cases))
    ok = report("matrix matches python-qrcode", matrix_bad)
    ok &= report("penalty score matches segno", penalty_bad)
    ok &= report("decodes back through zxingcpp", decode_bad)
    print("\n" + ("all checks passed" if ok else "FAILURES — see above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
