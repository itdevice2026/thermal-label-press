#!/usr/bin/env python3
"""Check the retail and logistics encoders against a reference and a decoder.

Code 128 will carry any string you hand it. EAN, UPC and ITF-14 will not: each
carries a GTIN, each ends in a check digit derived from the rest, and a symbol
that is a digit out scans cleanly to a number belonging to somebody else. So
these are checked three ways over the same sweep:

  1. the bar pattern, against python-barcode, module for module;
  2. a round trip through zxingcpp, the decoder a real scanner would agree with;
  3. the refusals — a wrong check digit, a wrong length, a letter in the middle
     — because printing nothing is the only safe answer to a bad number.

GS1-128 is checked by what comes back out: zxingcpp reports the symbology
identifier ]C1 and parses the application identifiers, so the assertion is that
the fields land where they were put.

ITF-14 is compared by decode only. python-barcode draws interleaved 2 of 5 at a
3:1 wide-to-narrow ratio and this encoder uses 2:1; both sit inside the range
the standard allows, so the patterns differ while both are correct.

    pip install python-barcode zxing-cpp
    python3 test/code-check.py
"""
import json, os, random, string, subprocess, sys, tempfile

import barcode
import numpy as np
import zxingcpp

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, os.pardir)
LINEAR = os.path.join(REPO, "js", "linear.js")
LABEL = os.path.join(REPO, "js", "label.js")

QUIET = {"ean13": (11, 7), "ean8": (7, 7), "upca": (9, 7), "itf14": (10, 10), "c128": (10, 10)}
REF = {"ean13": "ean13", "ean8": "ean8", "upca": "upca"}


def node(script):
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    if out.returncode:
        print(out.stderr)
        sys.exit("node failed")
    return out.stdout


def run_encoders(cases, gs1_cases, workdir):
    cpath = os.path.join(workdir, "cases.json")
    gpath = os.path.join(workdir, "gs1.json")
    opath = os.path.join(workdir, "out.json")
    json.dump(cases, open(cpath, "w"))
    json.dump(gs1_cases, open(gpath, "w"))
    script = """
      const fs = require('fs');
      const L = {exports:{}};
      new Function('module','exports', fs.readFileSync(%s,'utf8'))(L, L.exports);
      // code128 lives at the top of label.js, ahead of anything that needs a browser
      const src = fs.readFileSync(%s,'utf8');
      const C = {exports:{}};
      new Function('module','exports', src.slice(0, src.indexOf('/* EAN, UPC and ITF-14')) +
        '\\nmodule.exports={code128};')(C, C.exports);
      const { eanEncode, gs1Elements, gs1GtinOrNull, gs1DigitalLink } = L.exports;
      const { code128 } = C.exports;
      const cases = JSON.parse(fs.readFileSync(%s,'utf8'));
      const gs1 = JSON.parse(fs.readFileSync(%s,'utf8'));
      const out = cases.map(c => {
        try { const e = eanEncode(c.kind, c.raw); return {ok:true, modules:e.modules, text:e.text}; }
        catch(err){ return {ok:false, err:err.message}; }
      });
      const gout = gs1.map(g => {
        try {
          const gtin = gs1GtinOrNull(g.code);
          const built = gs1Elements({gtin, code:g.code, batch:g.batch, pd:g.pd, ed:g.ed});
          const row = {ok:true, data:built.data, parts:built.parts, modules:code128(built.data, true).modules};
          if (g.dl) { try { row.dl = gs1DigitalLink('https://id.gs1.org', {gtin, batch:g.batch, pd:g.pd, ed:g.ed}); }
                      catch(e){ row.dlErr = e.message; } }
          return row;
        } catch(err){ return {ok:false, err:err.message}; }
      });
      fs.writeFileSync(%s, JSON.stringify({out, gout}));
    """ % (json.dumps(LINEAR), json.dumps(LABEL), json.dumps(cpath), json.dumps(gpath), json.dumps(opath))
    node(script)
    return json.load(open(opath))


def to_image(modules, kind, scale=3, height=140):
    ql, qr = QUIET.get(kind, (10, 10))
    width = (len(modules) + ql + qr) * scale
    im = np.full((height, width), 255, np.uint8)
    for i, ch in enumerate(modules):
        if ch == "1":
            im[:, (i + ql) * scale:(i + ql + 1) * scale] = 0
    return im


def build_cases():
    random.seed(5)
    cases = []
    for _ in range(40):
        cases.append({"kind": "ean13", "raw": "".join(random.choice(string.digits) for _ in range(12))})
        cases.append({"kind": "ean8",  "raw": "".join(random.choice(string.digits) for _ in range(7))})
        cases.append({"kind": "upca",  "raw": "".join(random.choice(string.digits) for _ in range(11))})
        cases.append({"kind": "itf14", "raw": "".join(random.choice(string.digits) for _ in range(13))})
    # known-good published figures, given with and without the check digit
    cases += [{"kind": "ean13", "raw": "400638133393"}, {"kind": "ean13", "raw": "4006381333931"},
              {"kind": "upca",  "raw": "03600029145"},  {"kind": "upca",  "raw": "036000291452"},
              {"kind": "ean8",  "raw": "9638507"},      {"kind": "ean8",  "raw": "96385074"}]
    return cases


REFUSALS = [
    ("ean13", "4006381333930", "wrong check digit"),
    ("ean13", "40063813339",   "too short"),
    ("ean13", "40063813339311", "too long"),
    ("ean13", "40063813333X",  "not all digits"),
    ("ean8",  "96385075",      "wrong check digit"),
    ("upca",  "036000291451",  "wrong check digit"),
    ("itf14", "1234567890123456", "too long"),
    ("itf14", "39012473",      "too short"),
]

GS1_CASES = [
    {"code": "39012473",      "pd": "2026-08-26", "ed": "2027-08-26", "batch": "L2608A", "dl": True},
    {"code": "4006381333931", "pd": "2026-01-02", "ed": "2026-07-02", "batch": "",       "dl": True},
    {"code": "39012472",      "pd": "",           "ed": "2027-02-26", "batch": "ABC-01", "dl": True},
    {"code": "036000291452",  "pd": "2026-03-04", "ed": "2027-03-04", "batch": "X9",     "dl": True},
]


def main():
    cases = build_cases()
    with tempfile.TemporaryDirectory() as workdir:
        res = run_encoders(cases + [{"kind": k, "raw": r} for k, r, _ in REFUSALS], GS1_CASES, workdir)
    mine, gout = res["out"], res["gout"]
    good, refused = mine[:len(cases)], mine[len(cases):]

    pattern_bad, decode_bad, refuse_bad, gs1_bad = [], [], [], []

    for case, got in zip(cases, good):
        if not got["ok"]:
            pattern_bad.append((case, got["err"])); decode_bad.append((case, got["err"])); continue
        if case["kind"] in REF:
            ref = barcode.get_barcode_class(REF[case["kind"]])(case["raw"], writer=None).build()[0]
            if ref != got["modules"]:
                pattern_bad.append((case, "pattern differs"))
        read = zxingcpp.read_barcodes(to_image(got["modules"], case["kind"]))
        text = read[0].text if read else None
        # a UPC-A symbol is an EAN-13 with a leading zero; zxing reports it as such
        want = {got["text"], "0" + got["text"]}
        if text not in want:
            decode_bad.append((case, "read %r, wanted %s" % (text, got["text"])))

    for (kind, raw, why), got in zip(REFUSALS, refused):
        if got["ok"]:
            refuse_bad.append(((kind, raw, why), "accepted, and should not have been"))

    for case, got in zip(GS1_CASES, gout):
        if not got["ok"]:
            gs1_bad.append((case, got["err"])); continue
        read = zxingcpp.read_barcodes(to_image(got["modules"], "c128"))
        if not read:
            gs1_bad.append((case, "did not decode")); continue
        b = read[0]
        if b.symbology_identifier != "]C1":
            gs1_bad.append((case, "not flagged as GS1: %r" % b.symbology_identifier))
        want = "".join("(%s)%s" % (p["ai"], p["value"]) for p in got["parts"])
        if b.text != want:
            gs1_bad.append((case, "read %r, wanted %r" % (b.text, want)))
        if case.get("dl") and got.get("dl"):
            if not got["dl"].startswith("https://id.gs1.org/01/"):
                gs1_bad.append((case, "digital link malformed: %s" % got["dl"]))

    def report(name, bad, total):
        mark = "PASS" if not bad else "FAIL"
        print("%s  %-42s %d/%d" % (mark, name, total - len(bad), total))
        for item in bad[:5]:
            print("        %s" % (item,))
        return not bad

    print("Retail and logistics codes — %d symbols, %d refusals, %d GS1-128\n"
          % (len(cases), len(REFUSALS), len(GS1_CASES)))
    ok = report("bar pattern matches python-barcode", pattern_bad, len([c for c in cases if c["kind"] in REF]))
    ok &= report("decodes back through zxingcpp", decode_bad, len(cases))
    ok &= report("a bad number is refused, not printed", refuse_bad, len(REFUSALS))
    ok &= report("GS1-128 fields survive the round trip", gs1_bad, len(GS1_CASES))
    print("\n" + ("all checks passed" if ok else "FAILURES — see above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
