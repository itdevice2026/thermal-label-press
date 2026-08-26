/* ============================================================
   Code 128 encoder  (values 0-106: 103=StartA 104=StartB 105=StartC 106=Stop)
   ============================================================ */
const C128 = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
"221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
"221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
"212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
"231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
"231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
"314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
"112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
"111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
"214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
"114131","311141","411131","211412","211214","211232","2331112"];

function digitRun(s, i){ let n = 0; while (i + n < s.length && s[i+n] >= "0" && s[i+n] <= "9") n++; return n; }

/* Returns { modules: "1010...", codes: [...] } or throws on unsupported characters.
   `gs1` puts an FNC1 straight after the start code, which is the only thing
   that distinguishes GS1-128 from plain Code 128 — the bars are the same
   alphabet. A 0x1D in the data is an FNC1 too, used as a field separator after
   a variable-length application identifier. */
function code128(data, gs1){
  if (!data || !data.length) throw new Error("empty");
  for (const ch of data){
    const c = ch.charCodeAt(0);
    if (c > 126) throw new Error("Character “" + ch + "” cannot be encoded in Code 128 (use plain ASCII).");
  }
  const codes = [];
  let mode, i = 0;
  const head = digitRun(data, 0);
  if ((head === data.length && head >= 2 && head % 2 === 0) || head >= 4){ mode = "C"; codes.push(105); }
  else { mode = "B"; codes.push(104); }
  if (gs1) codes.push(102);                                  // FNC1 — valid in every subset

  while (i < data.length){
    const cc = data.charCodeAt(i);
    if (cc === 29){                                          // FNC1 as a field separator
      codes.push(102); i += 1;
      continue;
    }
    if (cc < 32){                                            // control character — Code A only
      if (mode !== "A"){ codes.push(101); mode = "A"; }      // Code A
      codes.push(cc + 64); i += 1;
      continue;
    }
    if (mode === "A"){
      const run = digitRun(data, i);
      if (run >= 4 && run % 2 === 0){ codes.push(99); mode = "C"; }
      else { codes.push(100); mode = "B"; }
      continue;
    }
    if (mode === "C"){
      const run = digitRun(data, i);
      if (run >= 2){ codes.push(parseInt(data.substr(i,2),10)); i += 2; }
      else { codes.push(100); mode = "B"; }                 // Code B
    } else {
      const run = digitRun(data, i);
      const toEnd = (i + run === data.length);
      if (run >= 6 || (run >= 4 && toEnd)){
        if (run % 2 === 1){ codes.push(cc - 32); i += 1; }
        codes.push(99); mode = "C";                          // Code C
      } else {
        codes.push(cc - 32); i += 1;
      }
    }
  }
  let sum = codes[0];
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
  codes.push(sum % 103);
  codes.push(106);

  let modules = "";
  for (const c of codes){
    const p = C128[c];
    for (let k = 0; k < p.length; k++) modules += (k % 2 === 0 ? "1" : "0").repeat(+p[k]);
  }
  return { modules, codes };
}

/* Barcode as an SVG string, sized in millimetres. */
function barcodeSVG(modules, moduleMM, heightMM){
  const w = modules.length * moduleMM;
  let rects = "", run = 0;
  for (let i = 0; i <= modules.length; i++){
    if (modules[i] === "1"){ run++; continue; }
    if (run){ rects += '<rect x="' + ((i - run) * moduleMM).toFixed(4) + '" y="0" width="' + (run * moduleMM).toFixed(4) + '" height="' + heightMM + '" />'; run = 0; }
  }
  return '<svg width="' + w.toFixed(3) + 'mm" height="' + heightMM + 'mm" viewBox="0 0 ' + w.toFixed(3) + ' ' + heightMM +
         '" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000" role="img" aria-label="Barcode">' + rects + '</svg>';
}

/* EAN, UPC and ITF-14 as an SVG string, drawn the way the standard asks.

   A retail symbol is not a strip of bars with a number printed underneath. The
   guard bars drop past the ends of the code and the digits sit in the gap
   between them; the leading digit of an EAN-13 lives out in the light margin,
   which is also what tells a scanner where the symbol begins. ITF-14 gets a
   bearer bar around it, so a scan across a clipped corner fails rather than
   returning a short, plausible, wrong number.

   `barWidthMM` measures the bars alone; the light margins are added around
   them, so the element is wider than that and deliberately so. */
function retailSVG(enc, barWidthMM, barHeightMM, fontMM){
  const u = barWidthMM / enc.modules.length;
  const q = enc.quiet;
  const bearer = enc.bearer ? Math.max(u * 4.5, 0.4) : 0;
  const drop   = enc.guards.length ? fontMM * 0.85 : 0;
  const textH  = fontMM * 1.15;
  const totalW = (q.left + enc.modules.length + q.right) * u + bearer * 2;
  const totalH = barHeightMM + drop + textH + bearer * 2;
  const x0 = q.left * u + bearer;

  const isGuard = i => enc.guards.some(g => i >= g[0] && i < g[1]);
  let bars = "", run = 0, runGuard = false;
  const flush = (end) => {
    if (!run) return;
    const h = barHeightMM + (runGuard ? drop : 0);
    bars += '<rect x="' + (x0 + (end - run) * u).toFixed(4) + '" y="' + bearer.toFixed(4) +
            '" width="' + (run * u).toFixed(4) + '" height="' + h.toFixed(4) + '"/>';
    run = 0;
  };
  for (let i = 0; i <= enc.modules.length; i++){
    const on = enc.modules[i] === "1", g = on && isGuard(i);
    if (on && run && g === runGuard){ run++; continue; }
    flush(i);
    if (on){ run = 1; runGuard = g; }
  }

  let frame = "";
  if (bearer){
    frame = '<rect x="0" y="0" width="' + totalW.toFixed(4) + '" height="' + bearer.toFixed(4) + '"/>' +
            '<rect x="0" y="' + (bearer + barHeightMM).toFixed(4) + '" width="' + totalW.toFixed(4) + '" height="' + bearer.toFixed(4) + '"/>' +
            '<rect x="0" y="0" width="' + bearer.toFixed(4) + '" height="' + (barHeightMM + bearer * 2).toFixed(4) + '"/>' +
            '<rect x="' + (totalW - bearer).toFixed(4) + '" y="0" width="' + bearer.toFixed(4) + '" height="' + (barHeightMM + bearer * 2).toFixed(4) + '"/>';
  }

  const baseY = bearer * 2 + barHeightMM + drop + fontMM * 0.78;
  let text = "";
  enc.digits.forEach(d => {
    const size = d.small ? fontMM * 0.85 : fontMM;
    let x, anchor;
    if (d.side === "left"){       x = (q.left - 1) * u + bearer;                          anchor = "end"; }
    else if (d.side === "right"){ x = (q.left + enc.modules.length + 1) * u + bearer;     anchor = "start"; }
    else {                        x = x0 + (d.at + d.span / 2) * u;                       anchor = "middle"; }
    text += '<text x="' + x.toFixed(4) + '" y="' + baseY.toFixed(4) + '" text-anchor="' + anchor +
            '" style="font-family:var(--label-num);font-size:' + size.toFixed(4) +
            'px;font-weight:700;letter-spacing:' + (u * 0.15).toFixed(4) + 'px">' + esc(d.ch) + "</text>";
  });

  const w = totalW.toFixed(3), h = totalH.toFixed(3);
  return '<svg width="' + w + 'mm" height="' + h + 'mm" viewBox="0 0 ' + w + " " + h +
         '" shape-rendering="crispEdges" role="img" aria-label="' + esc(enc.kind.toUpperCase()) + ' barcode">' +
         '<rect width="' + w + '" height="' + h + '" fill="#fff"/><g fill="#000">' + frame + bars + "</g>" +
         '<g fill="#000" shape-rendering="auto">' + text + "</g></svg>";
}

/* QR code as an SVG string, sized in millimetres.

   `codeMM` is the code itself; the quiet zone the standard requires — four
   modules of blank on every side — is added around it, so the element takes up
   rather more room than the code measures. Reserving it here is the point: on a
   label this crowded, the dates would otherwise sit right against the code and
   a scanner would struggle. */
function qrSVG(qr, codeMM, quiet){
  quiet = quiet == null ? 4 : quiet;
  const n = qr.size, u = codeMM / n, side = codeMM + u * quiet * 2;
  let rects = "";
  for (let y = 0; y < n; y++){
    let run = 0;
    for (let x = 0; x <= n; x++){
      if (x < n && qr.modules[y][x]){ run++; continue; }
      if (run){
        rects += '<rect x="' + ((x - run + quiet) * u).toFixed(4) + '" y="' + ((y + quiet) * u).toFixed(4) +
                 '" width="' + (run * u).toFixed(4) + '" height="' + u.toFixed(4) + '"/>';
        run = 0;
      }
    }
  }
  const s = side.toFixed(3);
  return '<svg width="' + s + 'mm" height="' + s + 'mm" viewBox="0 0 ' + s + " " + s +
         '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
         '<rect width="' + s + '" height="' + s + '" fill="#fff"/><g fill="#000">' + rects + "</g></svg>";
}

/* ============================================================
   State
   ============================================================ */
const DEFAULTS = {
  w:50, h:30, pad:1.4, dpi:203, dark:12, speed:4,
  title:3.3, date:2.7, num:3.0, bar:8, mod:0.38,
  barmode:"width", barw:30, suffix:"lf", fmtv:1,
  sym:"c128", qrmm:8, qrec:"M", dlbase:"https://id.gs1.org",
  cols:1, colgap:2,
  fmt:"mdy", pdl:"PD:", edl:"ED:", shownum:1
};
const SYM_NAME = {
  c128:"Code 128", gs1128:"GS1-128", ean13:"EAN-13", ean8:"EAN-8",
  upca:"UPC-A", itf14:"ITF-14", qr:"QR Code", qrdl:"QR Code · GS1 Digital Link"
};
/* Which family a symbology belongs to decides how it is drawn and measured.
   The retail ones draw their own digits and carry their own light margins;
   the two-dimensional ones are square. */
const SYM_RETAIL = ["ean13","ean8","upca","itf14"];
const SYM_2D     = ["qr","qrdl"];

/* The list is built here and painted into the picker, rather than written out
   in the markup. It lived in two places once and they drifted apart — the
   Print tab gained six code types that Label setup never heard about. */
const SYM_GROUPS = [
  ["Bars", [
    ["c128",   "Code 128 — the bars on the sample label"],
    ["gs1128", "GS1-128 — Code 128 carrying the dates and batch"],
    ["ean13",  "EAN-13 — retail checkout"],
    ["ean8",   "EAN-8 — retail checkout, small packs"],
    ["upca",   "UPC-A — retail checkout, North America"],
    ["itf14",  "ITF-14 — shipping cartons"]
  ]],
  ["Square", [
    ["qr",   "QR Code — a square, readable by phone"],
    ["qrdl", "QR Code · GS1 Digital Link — ready for 2D at the till"]
  ]]
];
function paintSymOptions(){
  const html = SYM_GROUPS.map(([group, opts]) =>
    '<optgroup label="' + esc(group) + '">' +
    opts.map(([v, t]) => '<option value="' + v + '">' + esc(t) + "</option>").join("") +
    "</optgroup>").join("");
  const el = $("#s-sym");
  if (!el) return;
  const cur = el.value;
  el.innerHTML = html;
  el.value = SYM_NAME[cur] ? cur : "c128";
}
const LOG_MAX = 2000;

const store = {
  read(k, fb){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch(e){ return fb; } },
  write(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
};

let house     = Object.assign({}, DEFAULTS);
let cfg       = Object.assign({}, house);
let customers = [];        /* lbl_customers */
let catalog   = [];        /* lbl_products, with customer_id kept as .cust */
let logbook   = [];        /* lbl_print_log, newest first */
let queue     = store.read("lbl.queue", []);   /* the queue is this browser's scratch pad */
let editingCustomer = null;
let zoom      = 2;

/* Stock and layout belong to the customer; the printer settings belong to the machine. */
const STOCK_KEYS   = ["w","h","pad","title","date","num","bar","mod","barmode","barw","fmt","pdl","edl","shownum","suffix","sym","qrmm","qrec","dlbase","cols","colgap"];
const PRINTER_KEYS = ["dpi","dark","speed"];

/* The label profile in force for a customer: its own stock over the house default,
   with this machine's printer settings layered on top. */
function profileFor(custId){
  const c = custById(custId);
  const prof = Object.assign({}, house);
  if (c && c.stock) STOCK_KEYS.forEach(k => { if (c.stock[k] !== undefined) prof[k] = c.stock[k]; });
  return prof;
}
function stockLabel(c){
  return c && c.stock ? c.stock.w + " × " + c.stock.h + " mm" : "";
}
/* Which customer's stock the Label setup tab is editing (blank = the house default). */
function editingScope(){ return $("#f-cust") ? $("#f-cust").value : ""; }

function uid(){ return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function custById(id){ return customers.find(c => c.id === id) || null; }
function custName(id){
  const c = custById(id);
  return c ? (c.name + (c.code ? " (" + c.code + ")" : "")) : "";
}
function needCompany(msgEl){
  if (customers.length) return false;
  const m = $(msgEl);
  if (m) m.textContent = "Add a customer first — every product belongs to one.";
  return true;
}
/* The Print tab and the product form offer approved customers only; a pending
   one is still listed on the Customers tab so it can be approved or corrected. */
function custOptions(sel, blankLabel, includePending){
  const cur = sel.value;
  const list = customers.filter(c => includePending || c.status !== "pending");
  sel.innerHTML = '<option value="">' + blankLabel + "</option>" +
    list.map(c => '<option value="' + c.id + '">' + esc(custName(c.id)) + "</option>").join("");
  sel.value = list.some(c => c.id === cur) ? cur : "";
}


const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(iso, c){
  c = c || cfg;
  if (!iso) return "";
  const p = iso.split("-"); if (p.length !== 3) return iso;
  const y = p[0], m = +p[1], d = p[2];
  switch (c.fmt){
    case "dmy":   return d + " " + MON[m-1] + " " + y;
    case "iso":   return y + "-" + p[1] + "-" + d;
    case "slash": return p[1] + "/" + d + "/" + y;
    default:      return MON[m-1] + " " + d + "," + y;
  }
}
function addMonths(iso, n){
  if (!iso) return "";
  const p = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(p[0], p[1]-1+n, p[2]));
  return dt.toISOString().slice(0,10);
}
function todayISO(){
  const d = new Date(); const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ============================================================
   Label rendering
   ============================================================ */
function currentLabel(){
  return {
    name:   $("#f-name").value.trim(),
    size:   $("#f-size").value.trim(),
    pd:     $("#f-pd").value,
    ed:     $("#f-ed").value,
    code:   $("#f-code").value.trim(),
    copies: Math.max(1, Math.min(500, parseInt($("#f-copies").value, 10) || 1)),
    cust:   $("#f-cust").value,         /* recorded with the run — never rendered on the label */
    batch:  $("#f-batch") ? $("#f-batch").value.trim() : "",
    /* Carried on the line itself so a queued label prints the code type that
       was in force when it was queued, even if the setting changes afterwards. */
    sym:    cfg.sym
  };
}

/* ---- the printout's proportions, measured off the reference label ----
   text lines share one size and one pitch; the barcode is 3.94 text-heights tall
   and 0.65 of the label wide; the number sits just under the bars, slightly larger. */
const LINE     = 1.115;   // line pitch, × text size
const GAP_BARS = 0.17;    // space above the bars, × text size
const GAP_NUM  = 0.10;    // space above the number, × text size
const R_BAR    = 3.94;    // bar height,   × text size
const R_NUM    = 1.08;    // number size,  × text size
const R_BARW   = 0.649;   // barcode width, × label width
/* What the scanner "types" after the number. The reference printout carries a
   line feed, so a scan lands the code and presses Enter. */
const SUFFIX = { "":"", lf:"\n", cr:"\r", crlf:"\r\n", tab:"\t" };
function payloadOf(code, c){ return code + (SUFFIX[(c || cfg).suffix] || ""); }
const R_FILL   = 0.90;    // how much of the label height the printed block fills

/* Die-cut stock often comes two or three labels across. The label itself does
   not change; the page the printer sees does — it is the whole web, and each
   printed page carries a row of them. */
function acrossOf(c){ return Math.max(1, Math.min(4, Math.round(+(c || cfg).cols) || 1)); }
function gapOf(c){ return acrossOf(c) > 1 ? Math.max(0, +(c || cfg).colgap || 0) : 0; }
function webWidth(c){
  c = c || cfg;
  const n = acrossOf(c);
  return Math.round((c.w * n + gapOf(c) * (n - 1)) * 100) / 100;
}

/* Builds one .label element. Returns {el, issues:[]} */
function buildLabel(data, c){
  c = c || cfg;
  const issues = [];
  const el = document.createElement("div");
  el.className = "label";
  el.style.width  = c.w + "mm";
  el.style.height = c.h + "mm";
  el.style.padding = c.pad + "mm";

  /* The printout's format: product name, pack size, PD and ED — one line each,
     one type size, one line pitch, all in the typewriter face. */
  if (data.name){
    const t = document.createElement("div");
    t.className = "ln";
    t.style.fontSize = c.title + "mm";
    t.style.lineHeight = LINE;
    t.textContent = data.name;
    el.appendChild(t);
  }
  if (data.size){
    const t = document.createElement("div");
    t.className = "ln";
    t.style.fontSize = c.title + "mm";
    t.style.lineHeight = LINE;
    t.textContent = data.size;
    el.appendChild(t);
  }

  if (data.pd || data.ed){
    const d = document.createElement("div");
    d.className = "dates";
    d.style.fontSize = c.date + "mm";
    d.style.lineHeight = LINE;
    if (data.pd){ const r = document.createElement("div"); r.textContent = c.pdl + " " + fmtDate(data.pd, c); d.appendChild(r); }
    if (data.ed){ const r = document.createElement("div"); r.textContent = c.edl + " " + fmtDate(data.ed, c); d.appendChild(r); }
    el.appendChild(d);
  }

  if (data.code){
    /* Every symbology carries the same identity; what differs is how much else
       travels with it, and who can read it. The label is laid out the same way
       either way — whatever is drawn here goes in the same slot the bars have
       always occupied. */
    const box = document.createElement("div");
    box.style.marginTop = (c.date * GAP_BARS) + "mm";
    const usable = c.w - c.pad * 2, dotMM = 25.4 / c.dpi;
    const gtin = gs1GtinOrNull(data.code);

    if (SYM_2D.indexOf(c.sym) >= 0){
      let payload = null, qr = null;
      try {
        payload = c.sym === "qrdl"
          ? gs1DigitalLink(c.dlbase, { gtin, batch: data.batch, pd: data.pd, ed: data.ed })
          : payloadOf(data.code, c);
        qr = qrEncode(payload, { ec: c.qrec || "M" });
      } catch(err){ issues.push(["bad", err.message]); }
      if (qr){
        const quiet = 4;
        const withQuiet = s => s * (qr.size + quiet * 2) / qr.size;
        let side = +c.qrmm || DEFAULTS.qrmm;
        if (withQuiet(side) > usable){
          side = usable * qr.size / (qr.size + quiet * 2);
          issues.push(["warn", "The QR code and its quiet zone are wider than a " + c.w +
            " mm label — trimmed to " + side.toFixed(1) + " mm. Widen the label or reduce the margin."]);
        }
        const u = side / qr.size;
        if (u < dotMM){
          issues.push(["bad", "Each QR module would be " + u.toFixed(3) + " mm, thinner than one printer dot (" +
            dotMM.toFixed(3) + " mm). It will not scan — make the code larger."]);
        } else if (u < 0.33){
          issues.push(["warn", "QR module " + u.toFixed(3) + " mm is below the 0.33 mm rule of thumb. Test a scan before a long run."]);
        }
        box.innerHTML = qrSVG(qr, side, quiet);
        el.appendChild(box);
        el._qr = qr; el._qrSide = side; el._payload = payload;
      }
    }

    else if (SYM_RETAIL.indexOf(c.sym) >= 0){
      let enc = null;
      try { enc = eanEncode(c.sym, data.code); } catch(err){ issues.push(["bad", err.message]); }
      if (enc){
        /* The light margins are part of the symbol, so the width that has to
           fit the label is the whole element, not just the bars. */
        const total = enc.modules.length + enc.quiet.left + enc.quiet.right;
        let barW = Math.min(+c.barw || usable, usable * enc.modules.length / total);
        const mod = barW / enc.modules.length;
        if (mod < dotMM){
          issues.push(["bad", "Module width " + mod.toFixed(3) + " mm is thinner than one printer dot (" +
            dotMM.toFixed(3) + " mm). A retail code printed this small will be rejected at the till."]);
        } else if (mod < 0.264){
          issues.push(["warn", "Module width " + mod.toFixed(3) + " mm is below the 80% magnification retail asks for (0.264 mm). Widen the code or use a larger label."]);
        }
        if (c.bar < 8) issues.push(["warn", "Barcode height " + c.bar + " mm is short; 8 mm or more scans more reliably."]);
        box.innerHTML = retailSVG(enc, barW, c.bar, c.num);
        el.appendChild(box);
        el._enc = enc; el._mod = mod; el._retail = enc;
        return { el, issues };            /* the digits are part of the symbol */
      }
    }

    else {
      const gs1 = c.sym === "gs1128";
      let enc = null, parts = null, payload = null;
      try {
        if (gs1){
          const built = gs1Elements({ gtin, code: data.code, batch: data.batch, pd: data.pd, ed: data.ed });
          parts = built.parts; payload = built.data;
          if (!payload) throw new Error("There is nothing to put in a GS1-128 yet — enter a barcode number, and a production or expiry date.");
          enc = code128(payload, true);
        } else {
          payload = payloadOf(data.code, c);
          enc = code128(payload);
        }
      } catch(err){ issues.push(["bad", err.message]); }
      if (enc){
        let mod;
        if (c.barmode === "width"){
          let target = c.barw;
          if (target > usable){
            target = usable;
            issues.push(["warn", "A " + c.barw + " mm barcode does not fit inside a " + c.w + " mm label — trimmed to " + usable.toFixed(1) + " mm. Widen the label or reduce the margin."]);
          }
          mod = target / enc.modules.length;
        } else {
          mod = c.mod;
          if (enc.modules.length * mod > usable){
            mod = usable / enc.modules.length;
            issues.push(["warn", "Barcode is wider than the label — bars narrowed to " + mod.toFixed(3) + " mm to fit."]);
          }
        }
        if (mod < dotMM){
          issues.push(["bad", "Module width " + mod.toFixed(3) + " mm is thinner than one printer dot (" + dotMM.toFixed(3) + " mm). Bars will print unevenly and may not scan."]);
        } else if (mod < 0.25){
          issues.push(["warn", "Module width " + mod.toFixed(3) + " mm is below the 0.25 mm rule of thumb — widen the barcode or shorten the number. Test a scan before a long run."]);
        }
        if (c.bar < 8) issues.push(["warn", "Barcode height " + c.bar + " mm is short; 8 mm or more scans more reliably."]);
        box.innerHTML = barcodeSVG(enc.modules, mod, c.bar);
        el.appendChild(box);
        el._enc = enc; el._mod = mod; el._parts = parts; el._payload = payload;
      }
    }

    if (el.contains(box) && +c.shownum){
      const n = document.createElement("div");
      n.className = "num";
      n.style.fontSize = c.num + "mm";
      n.style.marginTop = (c.date * GAP_NUM) + "mm";
      n.textContent = data.code;
      el.appendChild(n);
    }
  }
  return { el, issues };
}

/* ============================================================
   ZPL
   ============================================================ */
function mm2dots(mm, c){ return Math.round(mm * (c || cfg).dpi / 25.4); }

function buildZPL(data, copies, c){
  c = c || cfg;
  const across = acrossOf(c), gapDots = mm2dots(gapOf(c), c);
  const LW = mm2dots(c.w, c);                    /* one label */
  const W  = mm2dots(webWidth(c), c);            /* the whole web the printer feeds */
  const H = mm2dots(c.h, c), PAD = mm2dots(c.pad, c);

  /* One label's worth of fields, drawn at an offset. On stock two or three
     across, the same block is emitted once per column: the printer's page is
     the web, but each label's content has to stay inside its own die cut. */
  function column(x0){
    const L = [];
    let y = PAD;
    const inner = LW - PAD * 2;
    const fhT = mm2dots(c.title, c), pitch = Math.round(fhT * LINE);
    [data.name, data.size].filter(Boolean).forEach(line => {
      const lines = Math.max(1, Math.ceil(line.length * c.title * 0.6 / (c.w - c.pad * 2)));
      L.push("^FO" + (x0 + PAD) + "," + y + "^A0N," + fhT + "," + Math.round(fhT*0.6) +
             "^FB" + inner + "," + lines + ",0,C,0^FD" + line + "^FS");
      y += pitch * lines;
    });
    if (data.pd || data.ed){
      const fh = mm2dots(c.date, c);
      [data.pd && (c.pdl + " " + fmtDate(data.pd, c)), data.ed && (c.edl + " " + fmtDate(data.ed, c))]
        .filter(Boolean).forEach(line => {
          L.push("^FO" + (x0 + PAD) + "," + y + "^A0N," + fh + "," + Math.round(fh*0.6) +
                 "^FB" + inner + ",1,0,C,0^FD" + line + "^FS");
          y += Math.round(fh * LINE);
        });
    }
    if (!data.code) return L;

    const usable = c.w - c.pad * 2;
    const gtin = gs1GtinOrNull(data.code);
    const hex = s => String(s).replace(/[\x00-\x1f\\^~]/g, ch => "_" + ch.charCodeAt(0).toString(16).padStart(2,"0"));
    const centre = width => x0 + Math.max(0, Math.round((LW - width) / 2));

    if (SYM_2D.indexOf(c.sym) >= 0){
      let payload = null, qr = null;
      try {
        payload = c.sym === "qrdl"
          ? gs1DigitalLink(c.dlbase, { gtin, batch: data.batch, pd: data.pd, ed: data.ed })
          : payloadOf(data.code, c);
        qr = qrEncode(payload, { ec: c.qrec || "M" });
      } catch(e){ qr = null; }
      if (qr){
        /* ^BQ sizes a QR by whole-dot magnification, so the printed code is the
           nearest multiple of the module count rather than exactly qrmm. The
           printer runs its own encoder; it is handed the same text and the same
           error-correction level, so it lands on the same version. */
        const quiet = 4;
        const side = Math.min(+c.qrmm || DEFAULTS.qrmm, usable * qr.size / (qr.size + quiet * 2));
        const mag  = Math.max(1, Math.min(10, Math.round(mm2dots(side, c) / qr.size)));
        const codeDots = mag * qr.size;
        y += mm2dots(c.date * GAP_BARS, c) + mag * quiet;
        L.push("^FO" + centre(codeDots) + "," + y + "^BQN,2," + mag + "," + (c.qrec || "M") + ",7");
        L.push("^FH_^FD" + (c.qrec || "M") + "A," + hex(payload) + "^FS");
        y += codeDots + mag * quiet;
      }
    }

    else if (SYM_RETAIL.indexOf(c.sym) >= 0){
      let enc = null;
      try { enc = eanEncode(c.sym, data.code); } catch(e){ enc = null; }
      if (enc){
        /* The printer draws the guard bars and the digits itself, so it is sent
           the number rather than the pattern. ^BY sets the module width. */
        const total = enc.modules.length + enc.quiet.left + enc.quiet.right;
        const barW = Math.min(+c.barw || usable, usable * enc.modules.length / total);
        const modDots = Math.max(1, Math.round(mm2dots(barW / enc.modules.length, c)));
        y += mm2dots(c.date * GAP_BARS, c);
        L.push("^BY" + modDots + ",3.0," + mm2dots(c.bar, c));
        const cmd = { ean13:"^BEN,", ean8:"^B8N,", upca:"^BUN,", itf14:"^B2N," }[c.sym];
        const tail = c.sym === "itf14"
          ? mm2dots(c.bar, c) + ",Y,N,Y"          /* ITF-14: print the number, draw the bearer bar */
          : mm2dots(c.bar, c) + ",Y,N";
        L.push("^FO" + centre(enc.modules.length * modDots) + "," + y + cmd + tail + "^FD" + enc.text + "^FS");
      }
      return L;                                    /* a retail code prints its own digits */
    }

    else {
      const gs1 = c.sym === "gs1128";
      let enc = null, payload = null;
      try {
        if (gs1){
          payload = gs1Elements({ gtin, code: data.code, batch: data.batch, pd: data.pd, ed: data.ed }).data;
          enc = payload ? code128(payload, true) : null;
        } else {
          payload = payloadOf(data.code, c);
          enc = code128(payload);
        }
      } catch(e){ enc = null; }
      if (enc){
        const mod = (c.barmode === "width")
          ? Math.min(c.barw, usable) / enc.modules.length
          : Math.min(c.mod, usable / enc.modules.length);
        const modDots = Math.max(1, Math.round(mm2dots(mod, c)));
        y += mm2dots(c.date * GAP_BARS, c);
        L.push("^BY" + modDots + ",3.0," + mm2dots(c.bar, c));
        const at = "^FO" + centre(enc.modules.length * modDots) + "," + y;
        if (gs1){
          /* ^BC's "A" mode makes it a GS1-128: the printer inserts FNC1 and
             checks the identifiers rather than taking the string on trust. */
          L.push(at + "^BCN," + mm2dots(c.bar, c) + "," + (+c.shownum ? "Y" : "N") + ",N,N,A" +
                 "^FD" + payload.split(FNC1).join(">8") + "^FS");
        } else {
          L.push(at + "^BCN," + mm2dots(c.bar, c) + "," + (+c.shownum ? "Y" : "N") + ",N,N^FH_^FD" + hex(payload) + "^FS");
        }
      }
    }
    return L;
  }

  const L = ["^XA", "^CI28", "^PW" + W, "^LL" + H, "^LH0,0", "^MD" + c.dark, "^PR" + c.speed];
  for (let n = 0; n < across; n++) L.push.apply(L, column(n * (LW + gapDots)));
  /* ^PQ counts what the printer feeds, and it feeds a whole row at a time. */
  L.push("^PQ" + Math.max(1, Math.ceil((copies || 1) / across)) + ",0,0,N");
  L.push("^XZ");
  return L.join("\n");
}

/* ============================================================
   Preview
   ============================================================ */
/* True height of the stacked content, measured off-screen at 1:1 (mm). */
function measureLabelMM(data, c){
  c = c || cfg;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none";
  const el = buildLabel(data, c).el;
  probe.appendChild(el);
  document.body.appendChild(probe);
  const kids = el.children;
  let mm = 0;
  if (kids.length){
    const top = kids[0].getBoundingClientRect().top;
    const bot = kids[kids.length - 1].getBoundingClientRect().bottom;
    mm = (bot - top) / (96 / 25.4) + c.pad * 2;
  }
  probe.remove();
  return mm;
}

function fitZoom(sfx){
  const stage = $("#stage" + (sfx || ""));
  const w = stage ? stage.clientWidth : 0;
  if (!w) return 4;                       // hidden panel: don't constrain
  const mmpx = 96 / 25.4;
  return Math.max(1, Math.min(4, (w - 44) / (cfg.w * mmpx)));
}

function renderPreview(){
  const data = currentLabel();
  const { el, issues } = buildLabel(data);

  const mmpx = 96 / 25.4;
  const contentMM = measureLabelMM(data);
  let zApplied = zoom;
  ["", "2"].forEach(sfx => {
    const host = $("#stageInner" + sfx);
    if (!host) return;
    host.innerHTML = "";
    const node = sfx ? buildLabel(data).el : el;
    host.appendChild(node);
    const z = Math.min(zoom, fitZoom(sfx));
    if (!sfx) zApplied = z;
    node.style.transform = "scale(" + z + ")";
    host.style.height = (cfg.h * mmpx * z) + "px";
    host.style.width  = (cfg.w * mmpx * z) + "px";
  });

  const qr  = el._qr;
  const mod = qr ? (el._qrSide / qr.size) : (el._mod || cfg.mod);
  const bw  = el._enc ? el._enc.modules.length * mod : 0;
  const spec =
    '<span>label <b>' + cfg.w + " × " + cfg.h + '</b> mm</span>' +
    (acrossOf(cfg) > 1
      ? '<span><b>' + acrossOf(cfg) + '</b> across · roll <b>' + webWidth(cfg) + '</b> mm</span>'
      : "") +
    '<span><b>' + (SYM_NAME[cfg.sym] || SYM_NAME.c128) + "</b></span>" +
    (qr  ? '<span>QR <b>' + el._qrSide.toFixed(1) + " × " + el._qrSide.toFixed(1) + '</b> mm</span>' : "") +
    (bw  ? '<span>barcode <b>' + bw.toFixed(1) + " × " + Number(cfg.bar).toFixed(1) + '</b> mm</span>' : "") +
    '<span>module <b>' + mod.toFixed(3) + '</b> mm</span>' +
    '<span><b>' + cfg.dpi + '</b> dpi</span>' +
    (qr ? '<span>version <b>' + qr.version + "</b> · <b>" + qr.ec + '</b></span>' : "") +
    (el._enc ? '<span><b>' + el._enc.modules.length + '</b> modules</span>' : "");

  /* What is actually in the code, spelled out. A GS1-128 or a Digital Link
     carries several fields, and the only way to be sure the right ones went in
     is to be shown them. */
  const car = $("#carries");
  if (car){
    let html = "";
    if (el._parts && el._parts.length){
      html = '<div class="carries"><b>This barcode carries</b>' + el._parts.map(p =>
        '<div><span class="ai">(' + p.ai + ")</span> " + esc(p.name) + " <b>" + esc(p.value) + "</b></div>").join("") + "</div>";
    } else if (cfg.sym === "qrdl" && el._payload){
      html = '<div class="carries"><b>This QR opens</b><div class="mono">' + esc(el._payload) + "</div></div>";
    } else if (el._retail){
      html = '<div class="carries"><b>This barcode carries</b><div>' + SYM_NAME[cfg.sym] + " <b>" +
             esc(el._retail.text) + "</b> — the last digit is the check digit.</div></div>";
    }
    car.innerHTML = html;
    if ($("#carries2")) $("#carries2").innerHTML = html;
  }
  $("#specs").innerHTML = spec;
  if ($("#specs2")) $("#specs2").innerHTML = spec;

  if (cfg.barmode === "width" && el._enc) $("#s-mod").value = mod.toFixed(3);

  const ro = $("#bar-readout");
  if (ro){
    const dots = Math.max(1, Math.round(mod * cfg.dpi / 25.4));
    if (qr){
      ro.innerHTML = "This code is version <b>" + qr.version + "</b> at error correction <b>" + qr.ec +
        "</b> — <b>" + qr.size + " × " + qr.size + "</b> modules, so each is <b>" + mod.toFixed(3) + " mm</b> (" +
        dots + " dot" + (dots === 1 ? "" : "s") + " at " + cfg.dpi + " dpi). A quiet zone of four modules is kept " +
        "clear on every side, which is why the code takes up more room than its size suggests. A higher error " +
        "correction level survives more smudging but needs a larger code for the same number.";
    } else if (el._retail){
      const pct = (mod / 0.33 * 100);
      ro.innerHTML = "A retail code is measured as a percentage of its nominal size. At <b>" + mod.toFixed(3) +
        " mm</b> a module this one is printed at <b>" + pct.toFixed(0) + "%</b> magnification (" + dots + " dot" +
        (dots === 1 ? "" : "s") + " at " + cfg.dpi + " dpi); shops normally require <b>80% to 200%</b>. The light " +
        "margins on either side are part of the symbol — printing anything into them stops it scanning.";
    } else {
      const printed = el._enc ? (el._enc.modules.length * dots * 25.4 / cfg.dpi) : 0;
      ro.innerHTML = el._enc
        ? "This number needs <b>" + el._enc.modules.length + "</b> modules, so each bar unit is <b>" + mod.toFixed(3) +
          " mm</b> (" + dots + " dot" + (dots === 1 ? "" : "s") + " at " + cfg.dpi + " dpi). Sent as ZPL the printer snaps that to <b>" +
          printed.toFixed(1) + " mm</b> wide. A longer barcode number needs more modules — in this mode the barcode keeps its width and the bars get thinner."
        : "Enter a barcode number on the Print tab to see the measurement.";
    }
  }
  $("#pv-scale").textContent = "×" + zApplied.toFixed(1) + " on screen";

  if (contentMM > cfg.h + 0.15){
    issues.push(["bad", "The content is about " + contentMM.toFixed(1) + " mm tall but the label is only " + cfg.h +
      " mm — the top and bottom are being cut off. Lower the barcode height or the text sizes, or use taller stock."]);
  }

  const seen = new Set();
  const flagHTML = issues.filter(i => !seen.has(i[1]) && seen.add(i[1]))
    .map(i => '<div class="flag ' + i[0] + '"><span class="ic">' + (i[0] === "bad" ? "!" : "△") + '</span><span>' + esc(i[1]) + "</span></div>").join("")
    || (data.code ? '<div class="flag ok"><span class="ic">✓</span><span>' + (SYM_NAME[cfg.sym] || SYM_NAME.c128) +
        ' encoded and within tolerance for this stock.</span></div>' : "");
  $("#flags").innerHTML = flagHTML;
  if ($("#flags2")) $("#flags2").innerHTML = flagHTML;

  $("#zpl").textContent = buildZPL(data, data.copies);
  saveDraft();
}

function saveDraft(){
  store.write("lbl.draft", currentLabel());
}

