/* ============================================================
   The retail and logistics symbologies

   Code 128 (in label.js) will carry any number you like. These will not: EAN,
   UPC and ITF-14 encode a GTIN — a number allocated by GS1 — and every one of
   them ends in a check digit derived from the rest. Most of the code here is
   about refusing a number that is not one, clearly, rather than printing bars
   that scan to something that belongs to somebody else.

   Everything returns the same shape as code128():

     { modules, text, kind, quiet, guards, digits }

   `modules` is the bar pattern as 1s and 0s. `quiet` is the light margin the
   standard requires on each side, in modules. `guards` marks the bars that
   drop below the symbol, and `digits` says where the human-readable figures
   sit, so retailSVG() can draw a conformant symbol rather than a strip with a
   number underneath.
   ============================================================ */

/* EAN/UPC digit patterns. L and G encode the left half — which of the two is
   used for each position is itself how the thirteenth digit is carried, since
   there is no room for it in the bars. R encodes the right half. */
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const EAN_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

/* Interleaved 2 of 5: five elements per digit, narrow or wide, the odd digit
   in the bars and the even one in the spaces between them. */
const ITF_PAT = ["NNWWN","WNNNW","NWNNW","WWNNN","NNWNW","WNWNN","NWWNN","NNNWW","WNNWN","NWNWN"];
const ITF_WIDE = 2;                      /* wide:narrow — the standard allows 2.0 to 3.0 */

/* The modulo-10 check digit every GTIN ends with: weight the digits 3 and 1
   alternately from the right, and make the total up to a multiple of ten. */
function gtinCheckDigit(digits){
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += +digits[i] * w;
  return (10 - sum % 10) % 10;
}

/* Accepts the number with or without its check digit and returns the full
   figure, or throws with something a person can act on. */
function gtinNormalise(raw, len, name){
  const s = String(raw || "").replace(/\s/g, "");
  if (!/^\d+$/.test(s)) throw new Error(name + " takes digits only — “" + raw + "” has something else in it.");
  if (s.length === len - 1) return s + gtinCheckDigit(s);
  if (s.length === len){
    const want = gtinCheckDigit(s.slice(0, -1));
    if (+s[len-1] !== want){
      throw new Error(name + " needs " + len + " digits ending in a check digit. “" + s + "” should end in " +
                      want + ", not " + s[len-1] + " — check the number, or enter the first " + (len-1) +
                      " digits and let it be worked out.");
    }
    return s;
  }
  throw new Error(name + " needs " + (len-1) + " digits, or " + len + " with the check digit. “" + s +
                  "” has " + s.length + ".");
}

function eanEncode(kind, raw){
  if (kind === "ean13" || kind === "upca"){
    const len = kind === "upca" ? 12 : 13;
    const text = gtinNormalise(raw, len, kind === "upca" ? "UPC-A" : "EAN-13");
    const d = (kind === "upca" ? "0" + text : text).split("").map(Number);
    const parity = EAN_PARITY[d[0]];
    let m = "101";
    for (let i = 1; i <= 6; i++) m += (parity[i-1] === "L" ? EAN_L : EAN_G)[d[i]];
    m += "01010";
    for (let i = 7; i <= 12; i++) m += EAN_R[d[i]];
    m += "101";
    /* Guard bars run below the digits; the leading figure sits out in the
       light margin, and for UPC-A so does the check digit, smaller. */
    return {
      kind, text, modules: m, quiet: { left: kind === "upca" ? 9 : 11, right: 7 },
      guards: [[0,3],[45,50],[92,95]],
      digits: kind === "upca"
        ? [{ ch:text[0], side:"left", small:true },
           { ch:text.slice(1,6),  at:3,  span:42 },
           { ch:text.slice(6,11), at:50, span:42 },
           { ch:text[11], side:"right", small:true }]
        : [{ ch:text[0], side:"left", small:true },
           { ch:text.slice(1,7),  at:3,  span:42 },
           { ch:text.slice(7,13), at:50, span:42 }]
    };
  }

  if (kind === "ean8"){
    const text = gtinNormalise(raw, 8, "EAN-8");
    const d = text.split("").map(Number);
    let m = "101";
    for (let i = 0; i < 4; i++) m += EAN_L[d[i]];
    m += "01010";
    for (let i = 4; i < 8; i++) m += EAN_R[d[i]];
    m += "101";
    return {
      kind, text, modules: m, quiet: { left: 7, right: 7 },
      guards: [[0,3],[31,36],[64,67]],
      digits: [{ ch:text.slice(0,4), at:3,  span:28 },
               { ch:text.slice(4,8), at:36, span:28 }]
    };
  }

  if (kind === "itf14"){
    const text = gtinNormalise(raw, 14, "ITF-14");
    const wide = ITF_WIDE;
    let m = "1010";                                       /* start: four narrow elements */
    for (let i = 0; i < text.length; i += 2){
      const a = ITF_PAT[+text[i]], b = ITF_PAT[+text[i+1]];
      for (let k = 0; k < 5; k++){
        m += "1".repeat(a[k] === "W" ? wide : 1);          /* bar from the odd digit */
        m += "0".repeat(b[k] === "W" ? wide : 1);          /* space from the even one */
      }
    }
    m += "11".slice(0, wide) + "0" + "1";                  /* stop: wide bar, narrow space, narrow bar */
    /* ITF is printed inside a bearer bar, which stops a scanner clipping a
       corner of the symbol and reading a short, wrong number. */
    return { kind, text, modules: m, quiet: { left: 10, right: 10 },
             guards: [], bearer: true,
             digits: [{ ch:text, at:0, span:m.length, below:true }] };
  }

  throw new Error("Unknown symbology “" + kind + "”.");
}

/* ============================================================
   GS1-128 — the same bars as Code 128, carrying structured data

   A plain Code 128 says "39012473" and nothing else; a receiving system has to
   be told separately what that number means. GS1-128 prefixes each field with
   an application identifier, so one scan yields the item, the dates and the
   batch, each labelled.

   Fixed-length fields are placed first and the one variable-length field last,
   which is what lets the whole thing be read without a separator character
   between the fields.
   ============================================================ */
const GS1_AI = {
  "01":  { len:14, name:"GTIN" },
  "10":  { len:0,  name:"Batch or lot" },
  "11":  { len:6,  name:"Production date" },
  "17":  { len:6,  name:"Expiry date" },
  "21":  { len:0,  name:"Serial" },
  "240": { len:0,  name:"Company's own item code" },
  "3103":{ len:6,  name:"Net weight (kg)" }
};
const FNC1 = "\x1D";                     /* what the encoder turns into the FNC1 codeword */

function gs1Date(iso){
  if (!iso) return "";
  const p = iso.split("-");
  return p.length === 3 ? p[0].slice(2) + p[1] + p[2] : "";
}

/* Builds the element string from what the label already knows.
   Returns { data, parts:[{ai,name,value}] } — parts drive the readout. */
function gs1Elements(opts){
  const parts = [];
  const push = (ai, value) => { if (value) parts.push({ ai, name: GS1_AI[ai].name, value: String(value) }); };

  /* (01) says "this is a GTIN" and a receiving system will treat it as one, so
     it is used only for a number that really is one. A works number goes in
     (240), which is exactly what that identifier is for. */
  if (opts.gtin) push("01", opts.gtin);
  push("11", gs1Date(opts.pd));
  push("17", gs1Date(opts.ed));
  if (!opts.gtin) push("240", String(opts.code || "").trim().toUpperCase());
  push("10", (opts.batch || "").trim().toUpperCase());   /* variable length — kept last */

  /* Fixed-length fields need no separator. Only a variable-length field that
     is followed by something else does, and keeping (10) last avoids it. */
  let data = "";
  parts.forEach((p, i) => {
    const prev = parts[i-1];
    if (prev && GS1_AI[prev.ai].len === 0) data += FNC1;
    data += p.ai + p.value;
  });
  return { data, parts };
}

/* A GTIN for (01) must be 14 digits. A shorter GTIN is padded on the left,
   which is what the standard says to do — it is not the same as inventing one,
   so a number that is plainly not a GTIN is left out rather than dressed up. */
function gs1GtinOrNull(raw){
  const s = String(raw || "").replace(/\s/g, "");
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) return null;
  try { return gtinNormalise(s, s.length, "GTIN").padStart(14, "0"); }
  catch(e){ return null; }
}

/* ============================================================
   GS1 Digital Link

   The same identifiers again, written as a web address, so a shopper's phone
   opens a page while a scanner at the till still reads the GTIN out of it.
   This is the form GS1's move to 2D at retail asks for; a bare number in a QR
   is not it. The item and its batch go in the path, the dates in the query.
   ============================================================ */
function gs1DigitalLink(base, opts){
  if (!opts.gtin) throw new Error("A GS1 Digital Link has to start from a GTIN. This number is not one, so there is nothing to point at — use a plain QR code, or GS1-128, until GS1 has allocated you a GTIN.");
  let url = String(base || "https://id.gs1.org").replace(/\/+$/, "") + "/01/" + opts.gtin;
  const lot = (opts.batch || "").trim().toUpperCase();
  if (lot) url += "/10/" + encodeURIComponent(lot);
  const q = [];
  if (gs1Date(opts.pd)) q.push("11=" + gs1Date(opts.pd));
  if (gs1Date(opts.ed)) q.push("17=" + gs1Date(opts.ed));
  return url + (q.length ? "?" + q.join("&") : "");
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { eanEncode, gtinCheckDigit, gtinNormalise, gs1Elements, gs1GtinOrNull,
                     gs1Date, gs1DigitalLink, GS1_AI, FNC1 };
