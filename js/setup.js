/* ============================================================
   Settings
   ============================================================ */
const CFG_FIELDS = {
  "s-w":"w","s-h":"h","s-pad":"pad","s-dpi":"dpi","s-dark":"dark","s-speed":"speed",
  "s-title":"title","s-date":"date","s-num":"num","s-bar":"bar","s-mod":"mod",
  "s-barmode":"barmode","s-barw":"barw","s-suffix":"suffix",
  "s-sym":"sym","s-qrmm":"qrmm","s-qrec":"qrec","s-dlbase":"dlbase",
  "s-fmt":"fmt","s-pdl":"pdl","s-edl":"edl","s-shownum":"shownum"
};
function cfgToForm(){
  for (const id in CFG_FIELDS) $("#" + id).value = cfg[CFG_FIELDS[id]];
  if ($("#f-sym")) $("#f-sym").value = cfg.sym || "c128";
  const key = cfg.w + "x" + cfg.h;
  const sel = $("#s-preset");
  sel.value = Array.from(sel.options).some(o => o.value === key) ? key : "custom";
  syncBarMode();
}
/* In "width" mode the module width is a result, not an input — show it, don't accept it.
   And only one symbology's measurements are worth showing at a time. */
function syncBarMode(){
  const qr     = SYM_2D.indexOf(cfg.sym) >= 0;
  const retail = SYM_RETAIL.indexOf(cfg.sym) >= 0;
  const gs1    = cfg.sym === "gs1128";
  const byWidth = cfg.barmode === "width";
  $("#fld-mod").classList.toggle("off", byWidth);
  $("#s-mod").disabled = byWidth;
  $("#fld-barw").classList.toggle("off", !byWidth);
  $("#s-barw").disabled = !byWidth;
  /* Only the measurements that belong to the chosen code are shown. Hidden
     outright rather than dimmed — dimming is reserved for a field that is a
     result rather than an input. A retail code has a fixed pattern, so its
     width is the only thing to set; the sizing method does not apply. */
  [["#fld-barmode", qr || retail], ["#fld-barw", qr], ["#fld-bar", qr], ["#fld-mod", qr || retail],
   ["#fld-qrmm", !qr], ["#fld-qrec", !qr], ["#fld-dlbase", cfg.sym !== "qrdl"],
   ["#fld-suffix", qr || retail || gs1]].forEach(([sel, hide]) => {
    const el = $(sel); if (el) el.hidden = hide;
  });
  /* The batch only reaches a code that has somewhere to put it. */
  const batch = $("#fld-batch");
  if (batch) batch.hidden = !(gs1 || cfg.sym === "qrdl");
}
function formToCfg(){
  for (const id in CFG_FIELDS){
    const k = CFG_FIELDS[id], v = $("#" + id).value;
    cfg[k] = (typeof DEFAULTS[k] === "number") ? (parseFloat(v) || DEFAULTS[k]) : v;
  }
  saveActive();
  renderPreview();
}

/* Routes the working profile to its owner: printer settings to the machine,
   stock and layout to the selected customer (or to the house default). */
function saveActive(){
  const co = custById(editingScope());
  PRINTER_KEYS.forEach(k => house[k] = cfg[k]);
  /* A customer only gets its own stock once something about the stock actually differs —
     changing a printer setting shouldn't quietly detach it from the house default. */
  const differs = STOCK_KEYS.some(k => cfg[k] !== house[k]);
  if (co && (co.stock || differs)){
    co.stock = co.stock || {};
    STOCK_KEYS.forEach(k => co.stock[k] = cfg[k]);
    db.saveCustomerStock(co).catch(dbErr);
    renderCustomers();
  } else if (!co){
    STOCK_KEYS.forEach(k => house[k] = cfg[k]);
  }
  db.saveHouse().catch(dbErr);
  paintScope();
}

/* Adopt the stock of whichever customer is selected. */
function adoptProfile(){
  cfg = profileFor(editingScope());
  cfgToForm();
  paintScope();
  renderPreview();
}

function paintScope(){
  const el = $("#scope");
  if (!el) return;
  const co = custById(editingScope());
  if ($("#s-scope")) $("#s-scope").value = editingScope();
  const own = co && co.stock;
  el.innerHTML = co
    ? '<div class="flag ' + (own ? "ok" : "warn") + '"><span class="ic">' + (own ? "▣" : "△") + "</span><span>Editing the stock for <b>" +
      esc(co.name) + "</b>" + (own ? " — its own " + co.stock.w + " × " + co.stock.h + " mm." :
      " — it still follows the house default. Any change here gives it its own size.") + "</span></div>"
    : '<div class="flag ok"><span class="ic">▣</span><span>Editing the <b>house default</b>, used by customers that have no size of their own and by one-off labels. Pick a customer on the Print tab to set that customer’s stock.</span></div>';
  const btn = $("#b-reset");
  if (btn) btn.textContent = (co && co.stock) ? "Clear — follow house default" : "Reset to defaults";
}
function currentEnc(){
  try { return code128(payloadOf($("#f-code").value.trim() || "00000000", cfg)); } catch(e){ return null; }
}
/* Grows the type and bars to the largest scale that still fits the stock,
   with the real wrapped title measured rather than guessed. */
/* Sizes the printout's proportions to whatever stock is in the printer:
   one text size drives the dates, the bar height and the number, and the
   largest size that still fits the label is the one that gets used. */
function fitProfile(p, data){
  p.pad  = Math.max(0.8, Math.round(p.w * 0.026 * 10) / 10);
  /* The sample label's barcode takes about two thirds of the width. GS1-128 is
     far longer than a bare number and a retail code carries light margins that
     count against the same space, so both are given everything there is. */
  const share = (p.sym === "gs1128" || SYM_RETAIL.indexOf(p.sym) >= 0) ? 1 : R_BARW;
  p.barw = Math.round(Math.min(p.w * share, p.w - p.pad * 2) * 10) / 10;
  const apply = s => {
    p.title = Math.round(s * 100) / 100;
    p.date  = p.title;
    p.num   = Math.round(s * R_NUM * 100) / 100;
    p.bar   = Math.round(s * R_BAR * 100) / 100;
    /* A QR is square, so it is sized off the same text scale as the bar height
       and then held inside the printable width, quiet zone included. */
    p.qrmm  = Math.round(Math.min(s * R_BAR, (p.w - p.pad * 2) * 21 / 29) * 100) / 100;
  };
  let lo = 0.8, hi = 12, best = 0.8;
  for (let i = 0; i < 22; i++){
    const mid = (lo + hi) / 2;
    apply(mid);
    const mm = measureLabelMM(data, p);
    if (!mm) return p;                 /* nothing to lay out — leave the sizes alone */
    if (mm <= p.h * R_FILL){ best = mid; lo = mid; } else hi = mid;
  }
  apply(best);
  const enc = currentEnc();
  if (enc) p.mod = Math.round((p.barw / enc.modules.length) * 1000) / 1000;
  return p;
}
function autoFit(){
  fitProfile(cfg, currentLabel());
  cfgToForm(); saveActive(); renderPreview();
}

/* ============================================================
   CSV
   ============================================================ */
const cell = s => /[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g,'""') + '"' : String(s);
function csvRows(head, rows){ return head.join(",") + "\n" + rows.map(r => r.map(cell).join(",")).join("\n"); }

function toCSV(){
  return csvRows(["name","size","code","customer"], catalog.map(p => {
    const c = custById(p.cust);
    return [p.name, p.size || "", p.code, c ? (c.code || c.name) : ""];
  }));
}
function customersCSV(){
  return csvRows(["name","code","contact","address","notes","label_width_mm","label_height_mm"],
    customers.map(c => [c.name, c.code || "", c.contact || "", c.address || "", c.notes || "",
                        c.stock ? c.stock.w : "", c.stock ? c.stock.h : ""]));
}
function logCSV(){
  return csvRows(["when","by","customer","product","size","barcode","produced","expires","labels"],
    logbook.map(r => [r.when, r.by || "", r.cust, r.name || "", r.size || "", r.code || "",
                      r.pd ? fmtDate(r.pd) : "", r.ed ? fmtDate(r.ed) : "", r.copies]));
}
function parseCSV(text){
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"' && text[i+1] === '"'){ cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ","){ row.push(cell); cell = ""; }
    else if (c === "\n"){ row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim().length));
}
async function importCSV(text){
  if (!isAdmin()) return toast("Only an administrator can import");
  const rows = parseCSV(text);
  if (!rows.length) return toast("That file had no rows");
  let start = 0;
  const head = rows[0].map(h => h.trim().toLowerCase());
  let ci = { name:0, size:1, code:2, cust:3 };
  if (head.includes("name") || head.includes("code")){
    ci = { name: head.indexOf("name"), size: head.indexOf("size"), code: head.indexOf("code"), cust: head.indexOf("customer") };
    if (ci.cust < 0) ci.cust = head.indexOf("company");
    if (ci.size < 0) ci.size = head.indexOf("pack size");
    start = 1;
  }
  let added = 0, updated = 0, newCo = 0, skipped = 0;
  try {
    for (let r = start; r < rows.length; r++){
      const row = rows[r];
      const name  = (row[ci.name] || "").trim();
      const size  = (ci.size >= 0 ? (row[ci.size] || "") : "").trim();
      const code  = (row[ci.code] || "").trim();
      const cname = (ci.cust >= 0 ? (row[ci.cust] || "") : "").trim();
      if (!name || !code) continue;
      let c = cname && customers.find(x =>
        (x.code && x.code.toLowerCase() === cname.toLowerCase()) || x.name.toLowerCase() === cname.toLowerCase());
      if (cname && !c){                /* a customer named in the file but not on the list is created */
        const looksLikeCode = !/\s/.test(cname) && cname.length <= 12;
        c = { name: cname, code: looksLikeCode ? cname : "", contact:"", address:"", notes:"" };
        customers.push(c);
        await db.saveCustomer(c);
        newCo++;
      }
      if (!c){ skipped++; continue; }   /* every product belongs to a customer */
      const hit = catalog.findIndex(p => p.code === code);
      if (hit >= 0){
        Object.assign(catalog[hit], { name, size, cust: c.id });
        await db.saveProduct(catalog[hit]); updated++;
      } else {
        const p = { name, size, code, cust: c.id };
        catalog.push(p);
        await db.saveProduct(p); added++;
      }
    }
  } catch (e){ dbErr(e); }
  renderCustomers();
  toast(added + " added, " + updated + " updated" +
        (newCo ? ", " + newCo + " new customer" + (newCo === 1 ? "" : "s") : "") +
        (skipped ? ", " + skipped + " skipped (no customer)" : ""));
}

async function importCustomersCSV(text){
  if (!isAdmin()) return toast("Only an administrator can import");
  const rows = parseCSV(text);
  if (!rows.length) return toast("That file had no rows");
  let start = 0, ci = { name:0, code:1, contact:2, address:3, notes:4, w:5, h:6 };
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (head.includes("name")){
    ci = { name: head.indexOf("name"), code: head.indexOf("code"), contact: head.indexOf("contact"),
           address: head.indexOf("address"), notes: head.indexOf("notes"),
           w: head.indexOf("label_width_mm"), h: head.indexOf("label_height_mm") };
    start = 1;
  }
  const pick = (row, i) => (i >= 0 ? (row[i] || "") : "").trim();
  let added = 0, updated = 0;
  try {
    for (let r = start; r < rows.length; r++){
      const row = rows[r];
      const rec = { name: pick(row, ci.name), code: pick(row, ci.code), contact: pick(row, ci.contact),
                    address: pick(row, ci.address), notes: pick(row, ci.notes) };
      if (!rec.name) continue;
      const w = parseFloat(pick(row, ci.w)), h = parseFloat(pick(row, ci.h));
      if (w && h){
        const p = fitProfile(Object.assign({}, house, { w, h }), currentLabel());
        rec.stock = {};
        STOCK_KEYS.forEach(k => rec.stock[k] = p[k]);
      }
      const hit = customers.findIndex(c => (rec.code && c.code.toLowerCase() === rec.code.toLowerCase()) ||
                                            c.name.toLowerCase() === rec.name.toLowerCase());
      if (hit >= 0){ Object.assign(customers[hit], rec); await db.saveCustomer(customers[hit]); updated++; }
      else { const co = Object.assign({}, rec); customers.push(co); await db.saveCustomer(co); added++; }
    }
  } catch (e){ dbErr(e); }
  renderCustomers();
  toast(added + " added, " + updated + " updated");
}
async function download(name, text, type){
  /* Hosted copies of this page save through the viewer; the local copy uses a plain link. */
  try {
    const dl = (typeof claude !== "undefined" && claude.use) ? await claude.use("downloads") : null;
    if (dl){
      try { await dl.save({ filename:name, data:text }); toast("Saved " + name); return; }
      catch(err){
        const code = err && err.code;
        if (code === "declined" || code === "rate_limited") return;
        if (code === "extension_not_enabled" || code === "rejected_extension"){
          try { await dl.save({ filename:name.replace(/\.csv$/, ".txt"), data:text });
                toast("Saved as .txt — rename it to .csv"); return; } catch(e2){}
        }
        await copy(text, "Product list");
        return;
      }
    }
  } catch(e){}
  const blob = new Blob([text], { type: type || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

