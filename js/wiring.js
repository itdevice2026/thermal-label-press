/* ============================================================
   Chrome
   ============================================================ */
let toastTimer;
function toast(msg){
  const t = $("#toast");
  t.textContent = msg; t.classList.add("up");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("up"), 2200);
}
async function copy(text, what){
  try { await navigator.clipboard.writeText(text); toast(what + " copied"); }
  catch(e){
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(what + " copied"); }
    catch(e2){ toast("Copy blocked — select the text and copy it by hand"); }
    ta.remove();
  }
}

/* ---------- wiring ---------- */
$$(".tabs button").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.admin && !isAdmin()) return;
  selectTab(b.dataset.tab);
}));

["f-name","f-size","f-code","f-pd","f-ed","f-copies"].forEach(id =>
  $("#" + id).addEventListener("input", renderPreview));

$("#f-pick").addEventListener("change", e => { if (e.target.value !== "") loadProduct(+e.target.value); });
$("#f-cust").addEventListener("change", () => { renderCatalog(); adoptProfile(); });

$("[data-pd]").addEventListener("click", () => { $("#f-pd").value = todayISO(); renderPreview(); });
$$("[data-shelf]").forEach(b => b.addEventListener("click", () => {
  const pd = $("#f-pd").value || todayISO();
  $("#f-pd").value = pd;
  $("#f-ed").value = addMonths(pd, +b.dataset.shelf);
  renderPreview();
}));

$("#b-save").addEventListener("click", () => {
  const d = currentLabel();
  if (!d.code) return toast("Enter a barcode number first");
  if (!customers.length) return toast("Add a customer first — every product belongs to one");
  const cust = $("#f-cust").value;
  const hit = catalog.findIndex(p => p.code === d.code);
  if (!cust && (hit < 0 || !catalog[hit].cust)) return toast("Pick the customer above before saving this product");
  const row = hit >= 0
    ? Object.assign(catalog[hit], { name:d.name, size:d.size, cust: cust || catalog[hit].cust })
    : { name:d.name, size:d.size, code:d.code, cust };
  if (hit < 0) catalog.push(row);
  renderCatalog();
  db.saveProduct(row).then(() => toast(hit >= 0 ? "Product updated" : "Product saved")).catch(dbErr);
});

$("#b-add").addEventListener("click", () => {
  const name = $("#n-name").value.trim(), size = $("#n-size").value.trim(), code = $("#n-code").value.trim();
  const cust = $("#n-cust").value;
  if (needCompany("#add-msg")) return;
  if (!name || !code) return void ($("#add-msg").textContent = "A name and a barcode number are both required.");
  if (!cust) return void ($("#add-msg").textContent = "Choose the customer this product belongs to.");
  try { code128(code); } catch(e){ $("#add-msg").textContent = e.message; return; }
  const clash = catalog.findIndex(p => p.code === code);
  if (clash >= 0 && catalog[clash].code !== editingProduct){
    return void ($("#add-msg").textContent = "That barcode number is already saved.");
  }
  let row;
  if (editingProduct){
    const i = catalog.findIndex(p => p.code === editingProduct);
    row = Object.assign(catalog[i] || {}, { name, size, code, cust });
  } else {
    row = { name, size, code, cust };
    catalog.push(row);
  }
  const editing = !!editingProduct;
  clearProductForm();
  renderCatalog();
  db.saveProduct(row).then(() => {
    renderCatalog();
    toast(isAdmin() ? (editing ? "Updated " : "Added ") + name
                    : name + " sent for approval");
  }).catch(dbErr);
});
$("#b-pcancel").addEventListener("click", clearProductForm);

/* ---- customers ---- */
$("#b-cadd").addEventListener("click", () => {
  const rec = customerForm();
  if (!rec.name) return void ($("#cus-msg").textContent = "A customer name is required.");
  const clash = customers.findIndex(c => c.name.toLowerCase() === rec.name.toLowerCase() && c.id !== editingCustomer);
  if (clash >= 0) return void ($("#cus-msg").textContent = "That customer is already on the list.");
  let co;
  if (editingCustomer){
    const i = customers.findIndex(c => c.id === editingCustomer);
    const stock = stockFromForm(customers[i].stock);
    co = Object.assign(customers[i], rec);
    if (stock) co.stock = stock; else co.stock = null;
  } else {
    co = Object.assign({}, rec);
    const stock = stockFromForm(null);
    if (stock) co.stock = stock;
    customers.push(co);
  }
  const editing = !!editingCustomer;
  clearCustomerForm(); renderCustomers(); adoptProfile();
  db.saveCustomer(co).then(() => {
    renderCustomers();
    toast(isAdmin() ? (editing ? "Customer updated" : "Added " + co.name)
                    : co.name + " sent for approval");
  }).catch(dbErr);
});
$("#b-ccancel").addEventListener("click", clearCustomerForm);

/* ---- customer logo ---- */
$("#b-clogo").addEventListener("click", () => $("#c-logo-file").click());
$("#b-clogo-x").addEventListener("click", () => { pendingLogo = null; $("#c-logo-file").value = ""; paintLogoBox(); });
$("#c-logo-file").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    pendingLogo = await shrinkLogo(f);
    paintLogoBox();
    $("#cus-msg").textContent = "";
  } catch (err){
    $("#cus-msg").textContent = err.message;
  }
  e.target.value = "";
});

$("#cus-body").addEventListener("click", async e => {
  const ok = e.target.closest("[data-capprove]");
  if (ok){
    if (!isAdmin()) return;
    const c = customers[+ok.dataset.capprove]; if (!c) return;
    ok.disabled = true;
    try {
      await db.approveCustomer(c);
      c.status = "approved";
      renderCustomers(); adoptProfile();
      toast("Approved " + c.name);
    } catch (err){ dbErr(err); ok.disabled = false; }
    return;
  }
  const ed = e.target.closest("[data-cedit]"), del = e.target.closest("[data-cdel]");
  if (ed){
    const c = customers[+ed.dataset.cedit];
    editingCustomer = c.id;
    $("#c-name").value = c.name; $("#c-code").value = c.code || "";
    $("#c-contact").value = c.contact || ""; $("#c-addr").value = c.address || "";
    $("#c-notes").value = c.notes || "";
    pendingLogo = c.logo || null; paintLogoBox();
    $("#c-w").value = c.stock ? c.stock.w : "";
    $("#c-h").value = c.stock ? c.stock.h : "";
    $("#cus-title").textContent = "Edit customer";
    $("#b-cadd").textContent = "Save changes";
    $("#b-ccancel").style.display = "";
    $("#cus-msg").textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (del){
    const c = customers[+del.dataset.cdel];
    const n = catalog.filter(p => p.cust === c.id).length;
    if (n) return void ($("#cus-msg").textContent =
      "Move or delete this customer’s " + n + " product" + (n === 1 ? "" : "s") + " first.");
    customers.splice(+del.dataset.cdel, 1);
    if (editingCustomer === c.id) clearCustomerForm();
    if ($("#f-cust").value === c.id) $("#f-cust").value = "";
    renderCustomers();
    db.deleteCustomer(c).then(() => toast("Removed " + c.name)).catch(dbErr);
  }
});

$("#b-cexport").addEventListener("click", () => download("customers.csv", customersCSV(), "text/csv"));
$("#b-cimport").addEventListener("click", () => $("#c-file").click());
$("#c-file").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => importCustomersCSV(String(r.result));
  r.readAsText(f); e.target.value = "";
});

/* ---- log ---- */
$("#b-lexport").addEventListener("click", () => download("print-log.csv", logCSV(), "text/csv"));
$("#b-lclear").addEventListener("click", () => {
  if (!isAdmin()) return;
  if (!confirm("Clear the whole print log for everyone? This cannot be undone.")) return;
  logbook = []; renderLog();
  db.clearLog().then(() => toast("Log cleared")).catch(dbErr);
});

$("#cat-body").addEventListener("change", e => {
  const sel = e.target.closest(".rowco");
  if (!sel) return;
  const p = catalog[+sel.dataset.row];
  if (!sel.value) return void toast("Every product needs a customer");
  p.cust = sel.value;
  renderCatalog(); renderCustomers();
  db.saveProduct(p).then(() => toast(p.name + " → " + custName(p.cust))).catch(dbErr);
});

$("#cat-body").addEventListener("click", async e => {
  const ok = e.target.closest("[data-papprove]");
  if (ok){
    if (!isAdmin()) return;
    const p = catalog[+ok.dataset.papprove]; if (!p) return;
    ok.disabled = true;
    try {
      await db.approveProduct(p);
      p.status = "approved";
      renderCatalog();
      toast("Approved " + p.name);
    } catch (err){ dbErr(err); ok.disabled = false; }
    return;
  }
  const use = e.target.closest("[data-use]"), del = e.target.closest("[data-del]");
  const ed = e.target.closest("[data-pedit]");
  if (ed){ editProduct(+ed.dataset.pedit); return; }
  if (use){
    const i = +use.dataset.use;
    loadProduct(i);
    $$(".tabs button").forEach(x => x.setAttribute("aria-selected", String(x.dataset.tab === "print")));
    $$(".panel").forEach(p => p.classList.toggle("on", p.id === "p-print"));
    renderPreview();
  }
  if (del){
    const i = +del.dataset.del;
    const p = catalog[i];
    catalog.splice(i,1);
    if (editingProduct === p.code) clearProductForm();
    renderCatalog();
    db.deleteProduct(p).then(() => toast("Removed " + p.name)).catch(dbErr);
  }
});

$("#b-addq").addEventListener("click", () => {
  const d = currentLabel();
  if (!d.code && !d.name) return toast("Fill in the label first");
  queue.push(d); renderQueue(); toast("Queued ×" + d.copies);
});
$("#b-clearq").addEventListener("click", () => { queue = []; renderQueue(); });
$("#q-list").addEventListener("click", e => {
  const b = e.target.closest("[data-qdel]");
  if (b){ queue.splice(+b.dataset.qdel, 1); renderQueue(); }
});
/* The count on a queued line is editable in place. Re-rendering the whole list
   on every keystroke would steal the caret, so this updates the row's own
   number, the running total and the saved queue — and leaves the DOM alone. */
$("#q-list").addEventListener("input", e => {
  const box = e.target.closest("[data-qty]");
  if (!box) return;
  const q = queue[+box.dataset.qty];
  if (!q) return;
  const n = Math.max(1, Math.min(500, Math.floor(+box.value || 1)));
  q.copies = n;
  const total = queue.reduce((a, x) => a + x.copies, 0);
  $("#q-count").textContent = total + (total === 1 ? " label" : " labels");
  store.write("lbl.queue", queue);
});
/* Tidy the box up once the operator leaves it, so a blank or 0 does not linger. */
$("#q-list").addEventListener("change", e => {
  const box = e.target.closest("[data-qty]");
  if (!box) return;
  const q = queue[+box.dataset.qty];
  if (q) box.value = q.copies;
});
$("#b-printq").addEventListener("click", () => printLabels(queue));
$("#b-print").addEventListener("click", () => printLabels([currentLabel()]));
$("#b-copyzpl").addEventListener("click", () => copy($("#zpl").textContent, "ZPL"));

/* A file rather than the clipboard, so it can be sent to the printer as-is:
   Zebra Setup Utilities, `copy /b` to a shared queue, or straight at port 9100.
   ZPL wants CRLF and a trailing newline — some firmware ignores a last line
   that arrives without one. */
$("#b-dlzpl").addEventListener("click", () => {
  const zpl = $("#zpl").textContent.trim();
  if (!zpl) return toast("Nothing to send yet");
  const d = currentLabel();
  const stem = (d.code || d.name || "label").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  download((stem || "label") + ".zpl", zpl.replace(/\r?\n/g, "\r\n") + "\r\n", "text/plain");
});

$("#b-zoom").addEventListener("click", () => {
  zoom = zoom >= 4 ? 1 : zoom + 1;
  renderPreview();
});

$("#s-preset").addEventListener("change", e => {
  if (e.target.value === "custom") return;
  const p = e.target.value.split("x");
  $("#s-w").value = p[0]; $("#s-h").value = p[1];
  formToCfg(); autoFit();
});
Object.keys(CFG_FIELDS).forEach(id => {
  if (id !== "s-barmode") $("#" + id).addEventListener("input", formToCfg);
});

/* Switching sizing method carries the current measurement over, so the label doesn't jump. */
$("#s-barmode").addEventListener("change", () => {
  const was = cfg.barmode, now = $("#s-barmode").value;
  if (was === now) return;
  const enc = currentEnc();
  if (enc){
    if (now === "width")  cfg.barw = Math.round(Math.min(enc.modules.length * cfg.mod, cfg.w - cfg.pad*2) * 10) / 10;
    if (now === "module") cfg.mod  = Math.round((Math.min(cfg.barw, cfg.w - cfg.pad*2) / enc.modules.length) * 1000) / 1000;
  }
  cfg.barmode = now;
  cfgToForm(); saveActive(); renderPreview();
});
$("#b-fit").addEventListener("click", autoFit);
$("#b-reset").addEventListener("click", () => {
  const co = custById(editingScope());
  if (co && co.stock){
    delete co.stock;                       /* fall back to the house default */
    db.saveCustomerStock(co).catch(dbErr);
    renderCustomers();
    adoptProfile();
    toast(co.name + " now follows the house default");
  } else {
    house = Object.assign({}, house, DEFAULTS);
    db.saveHouse().catch(dbErr);
    adoptProfile();
    toast("Reset to defaults");
  }
});

$("#b-export").addEventListener("click", () => download("products.csv", toCSV(), "text/csv"));
$("#b-import").addEventListener("click", () => $("#f-file").click());
$("#f-file").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => importCSV(String(r.result));
  r.readAsText(f);
  e.target.value = "";
});

window.addEventListener("resize", () => { zoom = Math.min(zoom, fitZoom()); renderPreview(); });

/* ---------- boot ---------- */
/* Restores whatever was half-typed on the Print tab when the page was last open. */
function restoreDraft(){
  const d = store.read("lbl.draft", null);
  if (d){
    $("#f-name").value = d.name || ""; $("#f-size").value = d.size || "";
    $("#f-code").value = d.code || ""; $("#f-copies").value = d.copies || 1;
    if (d.cust && customers.some(c => c.id === d.cust)){ $("#f-cust").value = d.cust; renderCatalog(); }
    $("#f-pd").value = d.pd || todayISO();
    $("#f-ed").value = d.ed || addMonths($("#f-pd").value, 12);
  } else {
    if (catalog.length) loadProduct(0);
    $("#f-pd").value = todayISO();
    $("#f-ed").value = addMonths(todayISO(), 12);
  }
  zoom = Math.min(2, fitZoom());
}

/* ---- start ---- */
(async function start(){
  cfgToForm();
  paintDomain();
  document.body.classList.add("locked");
  sb.onSignOut = () => { me = null; showGate("login"); };
  await sb.ensureFresh();
  if (sb.user()) await afterSignIn();
  else showGate("login");
})();



/* Re-fits saved settings when the label format itself changes. */
function migrateFormat(){
  if (house.fmtv === 2) return;
  const data = currentLabel();
  fitProfile(house, data);
  house.fmtv = 2;
  customers.forEach(co => {
    if (!co.stock) return;
    const p = fitProfile(Object.assign({}, house, { w: co.stock.w, h: co.stock.h }), data);
    STOCK_KEYS.forEach(k => co.stock[k] = p[k]);
  });
  db.saveHouse().catch(dbErr);
  customers.filter(c => c.stock).forEach(c => db.saveCustomerStock(c).catch(dbErr));
}
