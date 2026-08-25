"use strict";

/* ============================================================
   Thermal Label Press — online edition
   Data and accounts live in Supabase; the label rendering, the Code 128
   encoder and the print path are the same code as the offline build.
   ============================================================ */

const CONFIG = window.LBL_CONFIG || {};
const sb = new SB(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, { storeKey: "lbl.session" });

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

let me = null;          /* { id, email, name, role } from lbl_profiles */
let profiles = [];      /* everyone, when an administrator is signed in */

function isAdmin(){ return !!me && me.role === "admin"; }
function isStaff(){ return !!me && (me.role === "admin" || me.role === "operator"); }

/* One place decides what a failed write looks like. */
function dbErr(e){
  console.error(e);
  const msg = (e && e.message) || "Something went wrong";
  toast(/reach the server/i.test(msg) ? "Offline — that change was not saved" : msg);
}

/* ============================================================
   The database layer
   In memory the app keeps the same shapes the offline build used, so every
   render function is unchanged. These functions are the only place that
   knows about tables and columns.
   ============================================================ */
const db = {
  async loadAll(){
    const [cus, prods, log, settings] = await Promise.all([
      sb.select("lbl_customers", "select=*&order=name.asc"),
      sb.select("lbl_products",  "select=*&order=name.asc"),
      sb.select("lbl_print_log", "select=*&order=printed_at.desc&limit=" + LOG_MAX),
      sb.select("lbl_settings",  "select=*&id=eq.house")
    ]);
    customers = (cus || []).map(c => ({
      id: c.id, name: c.name, code: c.code || "", contact: c.contact || "",
      address: c.address || "", notes: c.notes || "", stock: c.stock || null
    }));
    catalog = (prods || []).map(p => ({
      id: p.id, name: p.name, size: p.size || "", code: p.code, cust: p.customer_id || ""
    }));
    logbook = (log || []).map(r => ({
      when: (r.printed_at || "").replace("T", " ").slice(0, 16),
      by: r.by_name || "—", cust: r.customer_name || "—",
      name: r.product_name || "", size: r.size || "", code: r.code || "",
      pd: r.pd || "", ed: r.ed || "", copies: r.copies || 1
    }));
    const saved = (settings && settings[0] && settings[0].data) || {};
    house = Object.assign({}, DEFAULTS, saved);
  },

  saveHouse(){
    if (!isAdmin()) return Promise.resolve();
    const data = {};
    Object.keys(DEFAULTS).forEach(k => data[k] = house[k]);
    return sb.upsert("lbl_settings", [{ id: "house", data, updated_at: new Date().toISOString() }], "id");
  },

  async saveCustomer(co){
    const row = { name: co.name, code: co.code || "", contact: co.contact || "",
                  address: co.address || "", notes: co.notes || "", stock: co.stock || null };
    if (co.id){ await sb.update("lbl_customers", "id=eq." + co.id, row); return co; }
    const out = await sb.insert("lbl_customers", [row]);
    co.id = out[0].id;
    renderCustomers();
    return co;
  },
  saveCustomerStock(co){
    if (!co || !co.id || !isAdmin()) return Promise.resolve();
    return sb.update("lbl_customers", "id=eq." + co.id, { stock: co.stock || null });
  },
  deleteCustomer(co){
    return co.id ? sb.remove("lbl_customers", "id=eq." + co.id) : Promise.resolve();
  },

  async saveProduct(p){
    const row = { name: p.name, size: p.size || "", code: p.code, customer_id: p.cust };
    if (p.id){ await sb.update("lbl_products", "id=eq." + p.id, row); return p; }
    const out = await sb.insert("lbl_products", [row]);
    p.id = out[0].id;
    return p;
  },
  deleteProduct(p){
    return p.id ? sb.remove("lbl_products", "id=eq." + p.id) : Promise.resolve();
  },

  addLog(rows){
    if (!me) return Promise.resolve();
    return sb.insert("lbl_print_log", rows.map(r => ({
      by_id: me.id, by_name: me.name, customer_name: r.cust,
      product_name: r.name, size: r.size, code: r.code,
      pd: r.pd || null, ed: r.ed || null, copies: r.copies
    })));
  },
  clearLog(){ return sb.remove("lbl_print_log", "id=gt.0"); },

  loadProfiles(){ return sb.select("lbl_profiles", "select=*&order=created_at.asc"); },
  setRole(id, role){ return sb.update("lbl_profiles", "id=eq." + id, { role }); },
  removeProfile(id){ return sb.remove("lbl_profiles", "id=eq." + id); }
};

/* ============================================================
   Sign in
   Accounts are real Supabase accounts and the rules are enforced by
   row-level security in the database, so what a person can do does not
   depend on this page behaving itself.
   ============================================================ */
function showGate(which){
  document.body.classList.add("locked");
  $("#gate").hidden = false;
  ["login","signup","pending"].forEach(p => { $("#" + p + "-panel").hidden = (p !== which); });
  const first = { login: "#li-email", signup: "#su-email", pending: null }[which];
  if (first) setTimeout(() => { const el = $(first); if (el) el.focus(); }, 60);
}
function hideGate(){
  document.body.classList.remove("locked");
  $("#gate").hidden = true;
  $("#li-pass").value = "";
}

async function afterSignIn(){
  const u = sb.user();
  if (!u){ showGate("login"); return; }
  let prof = null;
  try {
    const rows = await sb.select("lbl_profiles", "select=*&id=eq." + u.id);
    prof = rows && rows[0];
  } catch (e){
    $("#li-msg").textContent = e.message;
    showGate("login");
    return;
  }
  if (!prof){                       /* the trigger makes one on sign-up; be patient once */
    await new Promise(r => setTimeout(r, 800));
    const rows = await sb.select("lbl_profiles", "select=*&id=eq." + u.id);
    prof = rows && rows[0];
  }
  me = prof ? { id: u.id, email: u.email, name: prof.name || u.email, role: prof.role } : null;

  if (!me || me.role === "pending"){
    $("#pending-who").textContent = (me && me.name) || (u && u.email) || "";
    showGate("pending");
    return;
  }
  hideGate();
  applyRole();
  await bootData();
}

async function bootData(){
  try {
    await db.loadAll();
  } catch (e){ dbErr(e); return; }
  renderCustomers();      /* fills the pickers, so the draft can select into them */
  restoreDraft();         /* the label must have content before anything measures it */
  migrateFormat();
  renderQueue();
  renderLog();
  adoptProfile();
  paintScope();
  if (isAdmin()) refreshProfiles();
}

function paintDomain(){
  $$(".signup-domain").forEach(el => el.textContent = CONFIG.SIGNUP_DOMAIN || "company");
}
function applyRole(){
  const admin = isAdmin();
  $("#who").style.display = me ? "" : "none";
  if (me){
    $("#who-name").textContent = me.name;
    $("#who-role").textContent = admin ? "Admin" : "Operator";
  }
  $$("[data-admin]").forEach(el => { el.style.display = admin ? "" : "none"; });
  const open = $$(".tabs button").find(b => b.getAttribute("aria-selected") === "true");
  if (!admin && (!open || open.dataset.admin)) selectTab("print");
}
function selectTab(name){
  $$(".tabs button").forEach(x => x.setAttribute("aria-selected", String(x.dataset.tab === name)));
  $$(".panel").forEach(p => p.classList.toggle("on", p.id === "p-" + name));
  renderPreview();
}

function gateBusy(form, on, label){
  const btn = $(form + " button[type=submit]");
  if (!btn) return;
  btn.disabled = on;
  if (on){ btn.dataset.was = btn.textContent; btn.textContent = label || "Working…"; }
  else if (btn.dataset.was){ btn.textContent = btn.dataset.was; }
}

$("#login-panel").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#li-email").value.trim(), pass = $("#li-pass").value;
  $("#li-msg").textContent = "";
  gateBusy("#login-panel", true, "Signing in…");
  try {
    await sb.signIn(email, pass);
    await afterSignIn();
  } catch (err){
    $("#li-msg").textContent = /invalid/i.test(err.message)
      ? "That email and password don’t match." : err.message;
    $("#li-pass").value = "";
  } finally { gateBusy("#login-panel", false); }
});

$("#signup-panel").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#su-name").value.trim(), email = $("#su-email").value.trim();
  const pass = $("#su-pass").value, pass2 = $("#su-pass2").value;
  const msg = $("#su-msg");
  msg.textContent = "";
  if (!name) return void (msg.textContent = "Please give your name — it goes on the print log.");
  if (pass.length < 8) return void (msg.textContent = "Use at least 8 characters for the password.");
  if (pass !== pass2)  return void (msg.textContent = "The two passwords don’t match.");
  gateBusy("#signup-panel", true, "Creating…");
  try {
    const out = await sb.signUp(email, pass, { name });
    if (out && out.access_token){ await afterSignIn(); }
    else {
      msg.style.color = "var(--ink-2)";
      msg.textContent = "Account created. Check " + email + " for the confirmation link, then sign in.";
    }
  } catch (err){
    msg.textContent = /restricted/i.test(err.message)
      ? "Sign-up is limited to @" + (CONFIG.SIGNUP_DOMAIN || "company") + " email addresses."
      : err.message;
  } finally { gateBusy("#signup-panel", false); }
});

$$("[data-gate]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  showGate(a.dataset.gate);
}));

$("#b-signout").addEventListener("click", async () => {
  await sb.signOut();
  me = null;
  location.reload();
});
$("#b-pending-out").addEventListener("click", async () => {
  await sb.signOut();
  location.reload();
});
$("#b-refresh").addEventListener("click", async () => {
  $("#b-refresh").disabled = true;
  try { await db.loadAll(); renderCustomers(); renderLog(); adoptProfile(); toast("Up to date"); }
  catch (e){ dbErr(e); }
  finally { $("#b-refresh").disabled = false; }
});

/* ---- who can do what ---- */
async function refreshProfiles(){
  try { profiles = await db.loadProfiles() || []; } catch (e){ return dbErr(e); }
  renderProfiles();
}
function renderProfiles(){
  const waiting = profiles.filter(p => p.role === "pending").length;
  $("#usr-count").textContent = profiles.length + (profiles.length === 1 ? " account" : " accounts") +
    (waiting ? " · " + waiting + " waiting" : "");
  $("#usr-body").innerHTML = profiles.length ? profiles.map(p =>
    "<tr><td>" + esc(p.name || "—") + (me && p.id === me.id ? ' <span class="cd">· you</span>' : "") +
    '</td><td><select class="rowrole" data-id="' + p.id + '"' + (me && p.id === me.id ? " disabled" : "") + ">" +
      ["admin","operator","pending"].map(r =>
        '<option value="' + r + '"' + (p.role === r ? " selected" : "") + ">" +
        { admin:"Administrator", operator:"Operator", pending:"Pending — no access" }[r] + "</option>").join("") +
    "</select></td>" +
    '<td class="mono">' + esc((p.created_at || "").slice(0,10)) + '</td>' +
    '<td class="acts">' + (me && p.id === me.id ? "" :
      '<button class="btn tiny danger" data-udel="' + p.id + '">Remove</button>') + "</td></tr>").join("")
    : '<tr><td colspan="4" class="empty">No accounts yet.</td></tr>';
}
$("#usr-body").addEventListener("change", async e => {
  const sel = e.target.closest(".rowrole");
  if (!sel || !isAdmin()) return;
  const id = sel.dataset.id, role = sel.value;
  const admins = profiles.filter(p => p.role === "admin" && p.id !== id).length;
  if (role !== "admin" && admins === 0){
    $("#usr-msg").textContent = "Keep at least one administrator.";
    return refreshProfiles();
  }
  try { await db.setRole(id, role); toast("Role updated"); await refreshProfiles(); }
  catch (err){ dbErr(err); refreshProfiles(); }
});
$("#usr-body").addEventListener("click", async e => {
  const del = e.target.closest("[data-udel]");
  if (!del || !isAdmin()) return;
  const id = del.dataset.udel;
  const p = profiles.find(x => x.id === id);
  if (p && p.role === "admin" && profiles.filter(x => x.role === "admin").length === 1)
    return void ($("#usr-msg").textContent = "Keep at least one administrator.");
  if (!confirm("Remove " + ((p && p.name) || "this account") + "’s access?")) return;
  try {
    await db.removeProfile(id);
    toast("Access removed");
    await refreshProfiles();
  } catch (err){ dbErr(err); }
});
