/* ============================================================
   QR Code encoder

   Self-contained, no dependencies — the app never loads anything from a CDN,
   so the whole of ISO/IEC 18004 that a label needs lives here: mode selection,
   Reed-Solomon over GF(256), the interleave, the eight masks and their penalty
   scores. It returns a plain matrix of 0s and 1s; drawing it is someone else's
   problem (see qrSVG in label.js).

   The tables are kept small on purpose. Rather than the usual forty-row block
   table, the block layout is derived arithmetically from two figures per
   version — the error-correction codewords per block and the number of blocks —
   exactly as the specification defines them.
   ============================================================ */

/* Error-correction codewords per block, indexed [ecLevel][version]. */
const QR_ECC_PER_BLOCK = {
  L: [-1, 7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
};
/* Number of error-correction blocks, indexed [ecLevel][version]. */
const QR_NUM_BLOCKS = {
  L: [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
};
const QR_EC_BITS = { L:1, M:0, Q:3, H:2 };     /* as written into the format information */
const QR_ALNUM   = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/* ---- the size figures the specification defines by formula ---- */
function qrRawDataModules(ver){
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2){
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
function qrTotalCodewords(ver){ return Math.floor(qrRawDataModules(ver) / 8); }
function qrDataCodewords(ver, ec){
  return qrTotalCodewords(ver) - QR_ECC_PER_BLOCK[ec][ver] * QR_NUM_BLOCKS[ec][ver];
}
function qrAlignPositions(ver){
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/* ---- GF(256) arithmetic, primitive polynomial 0x11D ---- */
function qrGFMul(a, b){
  let z = 0;
  for (let i = 7; i >= 0; i--){
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xFF;
}
function qrRSGenerator(degree){
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;                       /* the polynomial x^0, stored big-endian */
  let root = 1;
  for (let i = 0; i < degree; i++){
    for (let j = 0; j < degree; j++){
      g[j] = qrGFMul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
    root = qrGFMul(root, 2);
  }
  return g;
}
function qrRSRemainder(data, gen){
  const res = new Uint8Array(gen.length);
  for (const b of data){
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[res.length - 1] = 0;
    for (let i = 0; i < gen.length; i++) res[i] ^= qrGFMul(gen[i], factor);
  }
  return res;
}

/* ---- bit buffer ---- */
function qrBits(){
  const a = [];
  a.push8 = (val, len) => { for (let i = len - 1; i >= 0; i--) a.push((val >>> i) & 1); };
  return a;
}

/* Which mode can carry this text? Numeric is densest, then alphanumeric, then
   raw bytes; a single mode for the whole payload keeps the encoder honest and
   costs a handful of bits on the short codes a label carries. */
function qrPickMode(text){
  if (/^[0-9]*$/.test(text)) return "numeric";
  for (const ch of text) if (QR_ALNUM.indexOf(ch) < 0) return "byte";
  return "alnum";
}
function qrUTF8(text){
  const out = [];
  for (const ch of text){
    let cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}
function qrCountBits(mode, ver){
  const i = ver <= 9 ? 0 : (ver <= 26 ? 1 : 2);
  if (mode === "numeric") return [10, 12, 14][i];
  if (mode === "alnum")   return [9, 11, 13][i];
  return [8, 16, 16][i];
}
/* Bits the payload itself occupies, excluding mode and count. */
function qrPayloadBits(mode, text, bytes){
  if (mode === "numeric"){
    const n = text.length;
    return 10 * Math.floor(n / 3) + (n % 3 === 1 ? 4 : (n % 3 === 2 ? 7 : 0));
  }
  if (mode === "alnum") return 11 * Math.floor(text.length / 2) + (text.length % 2) * 6;
  return bytes.length * 8;
}
function qrWritePayload(bb, mode, text, bytes){
  if (mode === "numeric"){
    for (let i = 0; i < text.length; i += 3){
      const chunk = text.substr(i, 3);
      bb.push8(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
  } else if (mode === "alnum"){
    for (let i = 0; i + 1 < text.length; i += 2)
      bb.push8(QR_ALNUM.indexOf(text[i]) * 45 + QR_ALNUM.indexOf(text[i + 1]), 11);
    if (text.length % 2) bb.push8(QR_ALNUM.indexOf(text[text.length - 1]), 6);
  } else {
    for (const b of bytes) bb.push8(b, 8);
  }
}

/* ---- matrix ---- */
function qrNewGrid(size, fill){
  const g = [];
  for (let y = 0; y < size; y++) g.push(new Array(size).fill(fill));
  return g;
}
function qrDrawFunctionPatterns(m, fn, ver, ec){
  const size = m.length;
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size){ m[y][x] = v; fn[y][x] = 1; } };

  for (let i = 0; i < size; i++){                       /* timing patterns */
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  const finder = (cx, cy) => {                          /* finder plus separator */
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++){
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, (d !== 2 && d !== 4) ? 1 : 0);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  const ap = qrAlignPositions(ver);                     /* alignment patterns */
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++){
    const corner = (i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0);
    if (corner) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0);
  }
  qrDrawFormat(m, fn, ec, 0);                           /* a placeholder; rewritten per mask */

  if (ver >= 7){                                        /* version information */
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++){
      const bit = (bits >>> i) & 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
}
function qrDrawFormat(m, fn, ec, mask){
  const size = m.length;
  const set = (x, y, v) => { m[y][x] = v; fn[y][x] = 1; };
  const data = QR_EC_BITS[ec] << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++)  set(8, i, (bits >>> i) & 1);
  set(8, 7, (bits >>> 6) & 1);
  set(8, 8, (bits >>> 7) & 1);
  set(7, 8, (bits >>> 8) & 1);
  for (let i = 9; i < 15; i++)  set(14 - i, 8, (bits >>> i) & 1);

  for (let i = 0; i < 8; i++)   set(size - 1 - i, 8, (bits >>> i) & 1);
  for (let i = 8; i < 15; i++)  set(8, size - 15 + i, (bits >>> i) & 1);
  set(8, size - 8, 1);                                  /* the always-dark module */
}
function qrDrawCodewords(m, fn, data){
  const size = m.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2){
    if (right === 6) right = 5;                         /* the vertical timing column is skipped */
    for (let vert = 0; vert < size; vert++){
      for (let j = 0; j < 2; j++){
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < data.length * 8){
          m[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
        /* anything past the last codeword stays 0 — the remainder bits */
      }
    }
  }
}
const QR_MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
];
function qrApplyMask(m, fn, mask){
  const f = QR_MASKS[mask], size = m.length;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (!fn[y][x] && f(x, y)) m[y][x] ^= 1;
}
/* The four penalty rules of Table 11, which decide which mask is used.

   Rule 3 — the finder-like 1:1:3:1:1 pattern — is the one every implementation
   reads slightly differently, because the table does not say whether the ratio
   may be scaled or whether a pattern with quiet on both sides counts twice.
   This follows the plainest reading: the literal seven modules 1011101, with
   four light modules before or after (the edge of the symbol counting as
   light), scored once. That reading is shared with segno, so the score here can
   be checked against a second implementation rather than merely asserted — see
   test/qr-check.py.

   Any of the eight masks produces a valid symbol, so a difference of opinion
   here changes which of eight correct answers is printed, nothing more. */
const QR_N2 = 3, QR_N3 = 40, QR_N4 = 10;   /* N1 is folded into "run - 2" below */

function qrPenalty(m){
  const size = m.length;
  let n1 = 0, n2 = 0, n3 = 0, dark = 0;

  const runs = get => {                                  /* rule 1: five or more in a row */
    let prev = -1, run = 0;
    for (let i = 0; i < size; i++){
      const v = get(i);
      if (v === prev) run++;
      else { if (run >= 5) n1 += run - 2; run = 1; }
      prev = v;
    }
    if (run >= 5) n1 += run - 2;
  };
  const anyDark = (get, from, to) => {
    for (let i = Math.max(0, from); i < Math.min(size, to); i++) if (get(i)) return true;
    return false;
  };
  const finderLike = get => {                            /* rule 3 */
    const at = k => get(k);
    for (let i = 0; i + 7 <= size; ){
      const hit = at(i) === 1 && at(i+1) === 0 && at(i+2) === 1 && at(i+3) === 1 &&
                  at(i+4) === 1 && at(i+5) === 0 && at(i+6) === 1;
      if (!hit){ i++; continue; }
      const clearBefore = i === 0          || !anyDark(get, i - 4, i);
      const clearAfter  = i === size - 7   || !anyDark(get, i + 7, i + 11);
      if (clearBefore || clearAfter){ n3 += QR_N3; i += 7; }
      else i += 4;                                       /* the tail may start another one */
    }
  };

  for (let y = 0; y < size; y++){
    const row = i => m[y][i], col = i => m[i][y];
    runs(row); runs(col);
    finderLike(row); finderLike(col);
    for (const v of m[y]) dark += v;
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++){
    const c = m[y][x];
    if (c === m[y][x+1] && c === m[y+1][x] && c === m[y+1][x+1]) n2 += QR_N2;
  }
  const total = size * size;
  const n4 = QR_N4 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
  return n1 + n2 + n3 + n4;
}

/* ============================================================
   qrEncode(text, opts) -> { size, modules, version, ec, mask, mode }
   modules is an array of rows, each an array of 0/1.
   opts: { ec:"L"|"M"|"Q"|"H", minVersion, maxVersion, mask }
   ============================================================ */
function qrEncode(text, opts){
  opts = opts || {};
  const ec = QR_ECC_PER_BLOCK[opts.ec] ? opts.ec : "M";
  const minV = Math.max(1, opts.minVersion || 1);
  const maxV = Math.min(40, opts.maxVersion || 40);
  if (text === "" || text == null) throw new Error("Nothing to encode.");

  const mode  = qrPickMode(text);
  const bytes = mode === "byte" ? qrUTF8(text) : [];

  let ver = 0;
  for (let v = minV; v <= maxV; v++){
    const capacity = qrDataCodewords(v, ec) * 8;
    const needed = 4 + qrCountBits(mode, v) + qrPayloadBits(mode, text, bytes);
    if (needed <= capacity){ ver = v; break; }
  }
  if (!ver) throw new Error("Too much data for a QR code at error correction " + ec + ".");

  /* ---- data codewords ---- */
  const bb = qrBits();
  bb.push8({ numeric:1, alnum:2, byte:4 }[mode], 4);
  bb.push8(mode === "byte" ? bytes.length : text.length, qrCountBits(mode, ver));
  qrWritePayload(bb, mode, text, bytes);

  const capacity = qrDataCodewords(ver, ec) * 8;
  for (let i = 0; i < 4 && bb.length < capacity; i++) bb.push(0);
  while (bb.length % 8 !== 0) bb.push(0);
  const dataCW = [];
  for (let i = 0; i < bb.length; i += 8){
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bb[i + j];
    dataCW.push(b);
  }
  for (let pad = 0xEC; dataCW.length < capacity / 8; pad ^= 0xEC ^ 0x11) dataCW.push(pad);

  /* ---- blocks, error correction, interleave ---- */
  const numBlocks = QR_NUM_BLOCKS[ec][ver];
  const eccLen    = QR_ECC_PER_BLOCK[ec][ver];
  const total     = qrTotalCodewords(ver);
  const shortLen  = Math.floor(total / numBlocks) - eccLen;
  const numShort  = numBlocks - total % numBlocks;
  const gen = qrRSGenerator(eccLen);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++){
    const len = shortLen + (i < numShort ? 0 : 1);
    const dat = dataCW.slice(k, k + len); k += len;
    blocks.push({ dat, ecc: qrRSRemainder(dat, gen) });
  }
  const out = [];
  for (let i = 0; i < shortLen + 1; i++)
    for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < eccLen; i++)
    for (const b of blocks) out.push(b.ecc[i]);

  /* ---- draw, mask, choose ---- */
  const size = ver * 4 + 17;
  const m  = qrNewGrid(size, 0);
  const fn = qrNewGrid(size, 0);
  qrDrawFunctionPatterns(m, fn, ver, ec);
  qrDrawCodewords(m, fn, out);

  let mask = opts.mask;
  if (mask == null){
    let best = Infinity;
    for (let k = 0; k < 8; k++){
      qrApplyMask(m, fn, k);
      qrDrawFormat(m, fn, ec, k);
      const p = qrPenalty(m);
      if (p < best){ best = p; mask = k; }
      qrApplyMask(m, fn, k);                            /* masking is its own inverse */
    }
  }
  qrApplyMask(m, fn, mask);
  qrDrawFormat(m, fn, ec, mask);
  return { size, modules: m, version: ver, ec, mask, mode };
}

if (typeof module !== "undefined" && module.exports) module.exports = { qrEncode };
