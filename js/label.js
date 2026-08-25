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

/* Returns { modules: "1010...", codes: [...] } or throws on unsupported characters. */
function code128(data){
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

  while (i < data.length){
    const cc = data.charCodeAt(i);
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

/* ============================================================
   State
   ============================================================ */
const DEFAULTS = {
  w:50, h:30, pad:1.4, dpi:203, dark:12, speed:4,
  title:3.3, date:2.7, num:3.0, bar:8, mod:0.38,
  barmode:"width", barw:30, suffix:"lf", fmtv:1,
  fmt:"mdy", pdl:"PD:", edl:"ED:", shownum:1
};
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
const STOCK_KEYS   = ["w","h","pad","title","date","num","bar","mod","barmode","barw","fmt","pdl","edl","shownum","suffix"];
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
    cust:   $("#f-cust").value          /* recorded with the run — never rendered on the label */
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
    let enc = null;
    try { enc = code128(payloadOf(data.code, c)); } catch(err){ issues.push(["bad", err.message]); }
    if (enc){
      const usable = c.w - c.pad * 2;
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
      const dotMM = 25.4 / c.dpi;
      if (mod < dotMM){
        issues.push(["bad", "Module width " + mod.toFixed(3) + " mm is thinner than one printer dot (" + dotMM.toFixed(3) + " mm). Bars will print unevenly and may not scan."]);
      } else if (mod < 0.25){
        issues.push(["warn", "Module width " + mod.toFixed(3) + " mm is below the 0.25 mm rule of thumb — widen the barcode or shorten the number. Test a scan before a long run."]);
      }
      if (c.bar < 8) issues.push(["warn", "Barcode height " + c.bar + " mm is short; 8 mm or more scans more reliably."]);

      const box = document.createElement("div");
      box.style.marginTop = (c.date * GAP_BARS) + "mm";
      box.innerHTML = barcodeSVG(enc.modules, mod, c.bar);
      el.appendChild(box);
      el._enc = enc; el._mod = mod;

      if (+c.shownum){
        const n = document.createElement("div");
        n.className = "num";
        n.style.fontSize = c.num + "mm";
        n.style.marginTop = (c.date * GAP_NUM) + "mm";
        n.textContent = data.code;
        el.appendChild(n);
      }
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
  const W = mm2dots(c.w, c), H = mm2dots(c.h, c), PAD = mm2dots(c.pad, c);
  const L = [];
  L.push("^XA");
  L.push("^CI28");                       // UTF-8
  L.push("^PW" + W);
  L.push("^LL" + H);
  L.push("^LH0,0");
  L.push("^MD" + c.dark);
  L.push("^PR" + c.speed);

  let y = PAD;
  const fhT = mm2dots(c.title, c), pitch = Math.round(fhT * LINE);
  [data.name, data.size].filter(Boolean).forEach(line => {
    const lines = Math.max(1, Math.ceil(line.length * c.title * 0.6 / (c.w - c.pad * 2)));
    L.push("^FO" + PAD + "," + y + "^A0N," + fhT + "," + Math.round(fhT*0.6) +
           "^FB" + (W - PAD*2) + "," + lines + ",0,C,0^FD" + line + "^FS");
    y += pitch * lines;
  });
  if (data.pd || data.ed){
    const fh = mm2dots(c.date, c);
    [data.pd && (c.pdl + " " + fmtDate(data.pd, c)), data.ed && (c.edl + " " + fmtDate(data.ed, c))]
      .filter(Boolean).forEach(line => {
        L.push("^FO" + PAD + "," + y + "^A0N," + fh + "," + Math.round(fh*0.6) +
               "^FB" + (W - PAD*2) + ",1,0,C,0^FD" + line + "^FS");
        y += Math.round(fh * LINE);
      });
  }
  if (data.code){
    let enc = null;
    try { enc = code128(payloadOf(data.code, c)); } catch(e){ enc = null; }
    if (enc){
      const usable = c.w - c.pad * 2;
      const mod = (c.barmode === "width")
        ? Math.min(c.barw, usable) / enc.modules.length
        : Math.min(c.mod, usable / enc.modules.length);
      const modDots = Math.max(1, Math.round(mm2dots(mod, c)));
      const bw = enc.modules.length * modDots;
      const x  = Math.max(0, Math.round((W - bw) / 2));
      y += mm2dots(c.date * GAP_BARS, c);
      L.push("^BY" + modDots + ",3.0," + mm2dots(c.bar, c));
      const zdata = data.code + (SUFFIX[c.suffix] || "").replace(/[\s\S]/g, ch => "_" + ch.charCodeAt(0).toString(16).padStart(2,"0"));
      L.push("^FO" + x + "," + y + "^BCN," + mm2dots(c.bar, c) + "," + (+c.shownum ? "Y" : "N") + ",N,N^FH_^FD" + zdata + "^FS");
    }
  }
  L.push("^PQ" + (copies || 1) + ",0,0,N");
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

  const mod = el._mod || cfg.mod;
  const bw  = el._enc ? el._enc.modules.length * mod : 0;
  const spec =
    '<span>label <b>' + cfg.w + " × " + cfg.h + '</b> mm</span>' +
    (bw ? '<span>barcode <b>' + bw.toFixed(1) + " × " + Number(cfg.bar).toFixed(1) + '</b> mm</span>' : "") +
    '<span>module <b>' + mod.toFixed(3) + '</b> mm</span>' +
    '<span><b>' + cfg.dpi + '</b> dpi</span>' +
    (el._enc ? '<span><b>' + el._enc.modules.length + '</b> modules</span>' : "");
  $("#specs").innerHTML = spec;
  if ($("#specs2")) $("#specs2").innerHTML = spec;

  if (cfg.barmode === "width" && el._enc) $("#s-mod").value = mod.toFixed(3);

  const ro = $("#bar-readout");
  if (ro){
    const dots = Math.max(1, Math.round(mod * cfg.dpi / 25.4));
    const printed = el._enc ? (el._enc.modules.length * dots * 25.4 / cfg.dpi) : 0;
    ro.innerHTML = el._enc
      ? "This number needs <b>" + el._enc.modules.length + "</b> modules, so each bar unit is <b>" + mod.toFixed(3) +
        " mm</b> (" + dots + " dot" + (dots === 1 ? "" : "s") + " at " + cfg.dpi + " dpi). Sent as ZPL the printer snaps that to <b>" +
        printed.toFixed(1) + " mm</b> wide. A longer barcode number needs more modules — in this mode the barcode keeps its width and the bars get thinner."
      : "Enter a barcode number on the Print tab to see the measurement.";
  }
  $("#pv-scale").textContent = "×" + zApplied.toFixed(1) + " on screen";

  if (contentMM > cfg.h + 0.15){
    issues.push(["bad", "The content is about " + contentMM.toFixed(1) + " mm tall but the label is only " + cfg.h +
      " mm — the top and bottom are being cut off. Lower the barcode height or the text sizes, or use taller stock."]);
  }

  const seen = new Set();
  const flagHTML = issues.filter(i => !seen.has(i[1]) && seen.add(i[1]))
    .map(i => '<div class="flag ' + i[0] + '"><span class="ic">' + (i[0] === "bad" ? "!" : "△") + '</span><span>' + esc(i[1]) + "</span></div>").join("")
    || (data.code ? '<div class="flag ok"><span class="ic">✓</span><span>Code 128 encoded and within tolerance for this stock.</span></div>' : "");
  $("#flags").innerHTML = flagHTML;
  if ($("#flags2")) $("#flags2").innerHTML = flagHTML;

  $("#zpl").textContent = buildZPL(data, data.copies);
  saveDraft();
}

function saveDraft(){
  store.write("lbl.draft", currentLabel());
}

