/* ============================================================
   Catalog
   ============================================================ */
/* ============================================================
   Approval
   An operator may propose a product or a customer; it exists straight away but
   is marked pending and stays out of the Print tab until an administrator
   approves it. The database enforces all of this — see 0004 in
   supabase/migrations — so these helpers only decide what is shown.
   ============================================================ */
function isPending(row){ return row && row.status === "pending"; }
function pendingTag(row){ return isPending(row) ? '<span class="pendTag">PENDING</span>' : ""; }
function submitterName(row){
  if (!isPending(row)) return "";
  const p = profiles.find(x => x.id === row.by);
  const who = p ? p.name : (me && row.by === me.id ? me.name : "");
  return who ? '<span class="byline">proposed by ' + esc(who) + "</span>" : '<span class="byline">awaiting approval</span>';
}
/* Can the person signed in act on this row at all? Admins on anything;
   an operator only on their own proposal, while it is still pending. */
function canEditRow(row){
  return isAdmin() || (isPending(row) && me && row.by === me.id);
}
function paintPendingCounts(){
  [["#pend-prod", catalog], ["#pend-cust", customers]].forEach(([sel, list]) => {
    const el = $(sel); if (!el) return;
    const n = list.filter(isPending).length;
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
  });
}

function renderCatalog(){
  const who  = $("#f-cust").value;
  const mark = $("#f-cust-mark");
  if (mark) mark.innerHTML = logoMark(custById(who), "pickMark");
  const pick = $("#f-pick");
  const cur  = pick.value;
  /* Only approved products can be printed. A pending one exists and is
     visible on the Products tab, but never reaches a pack. */
  const visible = catalog.map((p,i) => [p,i])
    .filter(([p]) => p.status !== "pending")
    .filter(([p]) => !who || !p.cust || p.cust === who);

  /* The barcode number is in the list, not just filled in after choosing: two
     products can share a name and a pack size, and the number is what tells
     them apart — better seen before the choice than checked after it. */
  pick.innerHTML = '<option value="">Custom entry</option>' +
    visible.map(([p,i]) => '<option value="' + i + '">' +
      esc(p.name + (p.size ? " · " + p.size : "") + " · " + p.code) + "</option>").join("");
  pick.value = visible.some(([,i]) => String(i) === cur) ? cur : "";

  const waiting = catalog.filter(isPending).length;
  $("#cat-count").textContent = catalog.length + (catalog.length === 1 ? " product" : " products") +
    (waiting ? " · " + waiting + " awaiting approval" : "");
  $("#cat-body").innerHTML = catalog.length ? catalog.map((p,i) => {
    const pend = isPending(p);
    const acts = pend
      ? (isAdmin()
          ? '<button class="btn tiny primary" data-papprove="' + i + '">Approve</button> ' +
            '<button class="btn tiny danger" data-del="' + i + '">Reject</button>'
          : (canEditRow(p)
              ? '<button class="btn tiny" data-pedit="' + i + '">Edit</button> ' +
                '<button class="btn tiny danger" data-del="' + i + '">Withdraw</button>'
              : ""))
      : '<button class="btn tiny" data-use="' + i + '">Use</button>' +
        (isAdmin()
          ? ' <button class="btn tiny" data-pedit="' + i + '">Edit</button> ' +
            '<button class="btn tiny danger" data-del="' + i + '">Delete</button>'
          : "");
    return '<tr' + (pend ? ' class="isPending"' : "") + "><td>" + esc(p.name) + pendingTag(p) + submitterName(p) +
      "</td><td>" + esc(p.size || "—") + '</td><td class="mono">' + esc(p.code) +
      "</td><td>" + companyCell(p, i) +
      '</td><td class="acts">' + acts + "</td></tr>";
  }).join("")
    : '<tr><td colspan="5" class="empty">No products saved yet.</td></tr>';
  paintPendingCounts();

  const orphans = catalog.filter(p => !p.cust).length;
  $("#cat-warn").innerHTML = orphans
    ? '<div class="flag warn" style="margin:14px 18px 0"><span class="ic">△</span><span>' + orphans +
      (orphans === 1 ? " product has" : " products have") +
      " no customer yet. Pick one in the Customer column — every product belongs to a customer.</span></div>"
    : "";
}

/* The add form doubles as the edit form; a product is tracked by the barcode it had when editing began. */
let editingProduct = null;
function clearProductForm(){
  ["n-name","n-size","n-code"].forEach(id => $("#" + id).value = "");
  $("#n-cust").value = "";
  editingProduct = null;
  $("#prod-title").textContent = "Add a product";
  $("#b-add").textContent = "Add product";
  $("#b-pcancel").style.display = "none";
  $("#add-msg").textContent = "";
}
function editProduct(i){
  const p = catalog[i]; if (!p) return;
  editingProduct = p.code;
  $("#n-name").value = p.name; $("#n-size").value = p.size || "";
  $("#n-code").value = p.code; $("#n-cust").value = p.cust || "";
  $("#prod-title").textContent = "Edit product";
  $("#b-add").textContent = "Save changes";
  $("#b-pcancel").style.display = "";
  $("#add-msg").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("#n-name").focus();
}

/* The customer cell is editable in place, so a product is never stuck without one. */
function companyCell(p, i){
  const unset = !p.cust;
  if (!canEditRow(p)) return esc(custName(p.cust) || "—");
  return '<select class="rowco' + (unset ? " unset" : "") + '" data-row="' + i + '" aria-label="Customer for ' + esc(p.name) + '">' +
    '<option value=""' + (unset ? " selected" : "") + ">Set customer…</option>" +
    customers.map(c => '<option value="' + c.id + '"' + (c.id === p.cust ? " selected" : "") + ">" +
      esc(custName(c.id)) + "</option>").join("") + "</select>";
}

/* ============================================================
   Customers — every product belongs to one; held with the job and the log, never on the label
   ============================================================ */
function renderCustomers(){
  custOptions($("#f-cust"), "All customers");
  custOptions($("#n-cust"), "Select a customer…");   /* approved only */
  /* Label setup edits one company's stock at a time, and says which; without a
     picker of its own the only way to switch was to go back to the Print tab. */
  if ($("#s-scope")) custOptions($("#s-scope"), "House default — customers with no size of their own");
  const waitingC = customers.filter(isPending).length;
  $("#cus-count").textContent = customers.length + (customers.length === 1 ? " customer" : " customers") +
    (waitingC ? " · " + waitingC + " awaiting approval" : "");
  $("#cus-body").innerHTML = customers.length ? customers.map((c,i) => {
    const n = catalog.filter(p => p.cust === c.id).length;
    const stock = c.stock
      ? '<span class="mono">' + c.stock.w + " × " + c.stock.h + " mm</span>"
      : '<span class="mono" style="color:var(--ink-3)">' + house.w + " × " + house.h + " mm · house</span>";
    const pend = isPending(c);
    const acts = pend
      ? (isAdmin()
          ? '<button class="btn tiny primary" data-capprove="' + i + '">Approve</button> ' +
            '<button class="btn tiny danger" data-cdel="' + i + '">Reject</button>'
          : (canEditRow(c)
              ? '<button class="btn tiny" data-cedit="' + i + '">Edit</button> ' +
                '<button class="btn tiny danger" data-cdel="' + i + '">Withdraw</button>'
              : ""))
      : (isAdmin()
          ? '<button class="btn tiny" data-cedit="' + i + '">Edit</button> ' +
            '<button class="btn tiny danger" data-cdel="' + i + '">Delete</button>'
          : "");
    return '<tr' + (pend ? ' class="isPending"' : "") + '><td><span class="coName">' + logoMark(c, "coMark") +
      "<span>" + esc(c.name) + pendingTag(c) + submitterName(c) + '</span></span></td><td class="mono">' +
      esc(c.code || "—") + "</td><td>" + stock + "</td><td>" +
      esc(c.contact || "—") + "</td><td>" + esc(c.address || "—") + "</td><td>" + esc(c.notes || "—") +
      '</td><td class="mono">' + n + '</td><td class="acts">' + acts + "</td></tr>";
  }).join("") : '<tr><td colspan="8" class="empty">No customers yet. Add one before saving products.</td></tr>';
  paintPendingCounts();
  renderCatalog();
}

/* The mark shown beside a customer name. Absent is the normal case, so it
   costs nothing when a customer has no logo. */
function logoMark(c, cls){
  return c && c.logo ? '<img class="' + cls + '" src="' + esc(c.logo) + '" alt="">' : "";
}

/* Held on the form rather than read back from the DOM, so choosing a file and
   then cancelling leaves the saved customer untouched. */
let pendingLogo = null;
function paintLogoBox(){
  const box = $("#c-logo-box");
  box.innerHTML = pendingLogo
    ? '<img src="' + esc(pendingLogo) + '" alt="">'
    : '<span class="logoNone">none</span>';
  $("#b-clogo-x").style.display = pendingLogo ? "" : "none";
}

/* Shrinks whatever was chosen to something a database row can carry: 160px on
   the long side, WebP where the browser has it. A 400 KB photo lands at a few
   kilobytes, and the list stays one round trip. */
function shrinkLogo(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("That file could not be read"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That does not look like an image"));
      img.onload = () => {
        const max = 160;
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const cx = cv.getContext("2d");
        cx.drawImage(img, 0, 0, w, h);
        let url = "";
        try { url = cv.toDataURL("image/webp", 0.88); } catch(e){}
        if (url.indexOf("data:image/webp") !== 0) url = cv.toDataURL("image/png");
        if (url.length > 60000) return reject(new Error("That image is too detailed — try a simpler one"));
        resolve(url);
      };
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });
}

function customerForm(){
  return {
    name:    $("#c-name").value.trim(),
    code:    $("#c-code").value.trim(),
    contact: $("#c-contact").value.trim(),
    address: $("#c-addr").value.trim(),
    notes:   $("#c-notes").value.trim(),
    logo:    pendingLogo
  };
}
/* Width and height typed on the customer form: build a full stock profile, sized to fit. */
function stockFromForm(existing){
  const w = parseFloat($("#c-w").value), h = parseFloat($("#c-h").value);
  if (!w || !h) return null;
  if (existing && existing.w === w && existing.h === h) return existing;   // untouched — keep tuning
  const p = fitProfile(Object.assign({}, house, existing || {}, { w, h }), currentLabel());
  const stock = {};
  STOCK_KEYS.forEach(k => stock[k] = p[k]);
  return stock;
}
function clearCustomerForm(){
  ["c-name","c-code","c-contact","c-addr","c-notes","c-w","c-h"].forEach(id => $("#" + id).value = "");
  $("#c-logo-file").value = "";
  pendingLogo = null; paintLogoBox();
  editingCustomer = null;
  $("#cus-title").textContent = "Add a customer";
  $("#b-cadd").textContent = "Add customer";
  $("#b-ccancel").style.display = "none";
  $("#cus-msg").textContent = "";
}

/* ============================================================
   Print log
   ============================================================ */
function stamp(d){
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function logPrint(list){
  const when = stamp(new Date());
  const who  = $("#f-cust").value;
  const rows = list.map(d => ({
    when, by: me ? me.name : "—", cust: custName(d.cust || who) || "—",
    name: d.name, size: d.size, code: d.code, pd: d.pd, ed: d.ed, copies: d.copies
  }));
  rows.forEach(r => logbook.unshift(r));
  if (logbook.length > LOG_MAX) logbook.length = LOG_MAX;
  renderLog();
  db.addLog(rows).catch(dbErr);     /* the run already printed; a failed write must not undo it */
}
function renderLog(){
  const total = logbook.reduce((a,r) => a + (r.copies || 0), 0);
  $("#log-count").textContent = logbook.length + (logbook.length === 1 ? " run · " : " runs · ") + total + " labels";
  $("#log-body").innerHTML = logbook.length ? logbook.slice(0, 400).map(r =>
    '<tr><td class="mono">' + esc(r.when) + "</td><td>" + esc(r.by || "—") + "</td><td>" + esc(r.cust) + "</td><td>" + esc(r.name || "—") +
    "</td><td>" + esc(r.size || "—") + '</td><td class="mono">' + esc(r.code || "—") + '</td><td class="mono">' +
    esc([r.pd, r.ed].filter(Boolean).map(fmtDate).join(" → ") || "—") + '</td><td class="mono">' + r.copies + "</td></tr>").join("")
    : '<tr><td colspan="8" class="empty">Nothing printed yet.</td></tr>';
}

function loadProduct(i){
  const p = catalog[i]; if (!p) return;
  if (p.cust && $("#f-cust").value !== p.cust){ $("#f-cust").value = p.cust; renderCatalog(); adoptProfile(); }
  $("#f-pick").value = String(i);
  $("#f-name").value = p.name;
  $("#f-size").value = p.size || "";
  $("#f-code").value = p.code;
  renderPreview();
}

/* ============================================================
   Queue
   ============================================================ */
function renderQueue(){
  const n = queue.reduce((a,q) => a + q.copies, 0);
  $("#q-count").textContent = n + (n === 1 ? " label" : " labels");
  $("#q-list").innerHTML = queue.length ? queue.map((q,i) =>
    '<div class="qrow"><span class="qtyBox"><span class="qtyX">×</span>' +
      '<input type="number" class="qty" min="1" max="500" step="1" value="' + q.copies +
      '" data-qty="' + i + '" aria-label="Copies of ' + esc([q.name, q.size].filter(Boolean).join(" ")) + '"></span>' +
    '<span class="nm">' + esc([q.name, q.size].filter(Boolean).join(" ")) +
      (q.cust ? ' <span class="cd">· ' + esc(custName(q.cust)) + "</span>" : "") + '</span>' +
    '<span class="cd">' + esc(q.code) + '</span>' +
    '<button class="btn ghost tiny danger" data-qdel="' + i + '">Remove</button></div>').join("")
    : '<div class="empty">Nothing queued. Add labels here to print several products in one run.</div>';
  store.write("lbl.queue", queue);
}

/* ============================================================
   Printing
   ============================================================ */
/* A run can mix customers, so each label carries its own stock size onto its own page. */
function printLabels(list){
  const sheet = $("#sheet");
  sheet.innerHTML = "";
  const sizes = [];        /* distinct "W×H" in this run, in order */
  let total = 0;
  list.forEach(d => {
    const prof = profileFor(d.cust);
    if (d.sym) prof.sym = d.sym;          /* the line's own choice wins over the stock's */
    const key = prof.w + "x" + prof.h;
    let idx = sizes.indexOf(key);
    if (idx < 0){ sizes.push(key); idx = sizes.length - 1; }
    for (let i = 0; i < d.copies; i++){
      if (total++ > 500) return;
      const el = buildLabel(d, prof).el;
      el.classList.add("pg" + idx);
      sheet.appendChild(el);
    }
  });
  if (!total){ toast("Nothing to print"); return; }
  logPrint(list);
  let ps = document.getElementById("pageStyle");
  if (!ps){ ps = document.createElement("style"); ps.id = "pageStyle"; document.head.appendChild(ps); }
  ps.textContent = sizes.map((key, i) => {
    const wh = key.split("x");
    return "@page pg" + i + "{size:" + wh[0] + "mm " + wh[1] + "mm;margin:0}" +
           "#sheet .label.pg" + i + "{page:pg" + i + "}";
  }).join("\n") + "\n@page{size:" + sizes[0].replace("x", "mm ") + "mm;margin:0}";
  window.print();
}

