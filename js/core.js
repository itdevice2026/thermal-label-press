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
  setName(id, name){ return sb.update("lbl_profiles", "id=eq." + id, { name }); },
  removeProfile(id){ return sb.remove("lbl_profiles", "id=eq." + id); },
  touch(){ return sb.rpc("lbl_touch"); },

  /* Making a login, changing a password and taking access away all need more
     privilege than a browser may hold, so they go through the lbl-users
     function, which checks the caller is an administrator before acting. */
  async admin(action, payload){
    await sb.ensureFresh();
    const s = sb.session;
    const res = await fetch(CONFIG.SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/lbl-users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.SUPABASE_KEY,
        Authorization: "Bearer " + (s ? s.access_token : "")
      },
      body: JSON.stringify(Object.assign({ action }, payload))
    }).catch(() => null);
    if (!res) throw new Error("Can’t reach the server. Check the internet connection.");
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "That didn’t work (" + res.status + ")");
    return out;
  }
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
  db.touch().catch(() => {});      /* the Users tab shows when each person was last here */
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
/* Lock puts the gate back up without ending the session, so stepping away from
   a shared label PC does not cost the next person a full sign-in. The password
   is still required to get back in — the session is only unlocked, not kept
   open — but the email is already filled in. */
$("#b-lock").addEventListener("click", () => {
  const u = sb.user();
  $("#li-email").value = (u && u.email) || "";
  $("#li-pass").value  = "";
  $("#li-msg").textContent = "Locked. Sign in to carry on.";
  showGate("login");
  setTimeout(() => $("#li-pass").focus(), 80);
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
const ROLE_LABEL = { admin: "ADMIN", operator: "OPERATOR", pending: "PENDING" };
function stampSeen(iso){
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function renderProfiles(){
  const waiting = profiles.filter(p => p.role === "pending").length;
  $("#usr-count").textContent = profiles.length + (profiles.length === 1 ? " user" : " users") +
    (waiting ? " · " + waiting + " waiting" : "");
  $("#usr-body").innerHTML = profiles.length ? profiles.map((p,i) =>
    "<tr><td>" + esc(p.name || "—") + (me && p.id === me.id ? ' <span class="cd">· you</span>' : "") +
    '</td><td class="mono">' + esc(p.email || "—") + "</td>" +
    '<td><span class="chip">' + (ROLE_LABEL[p.role] || esc(p.role)) + "</span></td>" +
    '<td class="mono">' + esc(stampSeen(p.last_seen)) + "</td>" +
    '<td class="acts"><button class="btn tiny" data-uedit="' + i + '">Edit</button> ' +
    (me && p.id === me.id ? "" : '<button class="btn tiny danger" data-udel="' + i + '">Delete</button>') +
    "</td></tr>").join("")
    : '<tr><td colspan="5" class="empty">No users yet.</td></tr>';
}

/* The add form doubles as the edit form, exactly as the product and customer
   forms do. Editing an existing user leaves the password boxes optional —
   filling them in sets a new password, leaving them blank keeps the old one. */
let editingUser = null;
function clearUserForm(){
  ["u-name","u-user","u-pin","u-pin2"].forEach(id => $("#" + id).value = "");
  $("#u-role").value = "operator";
  $("#u-user").disabled = false;
  editingUser = null;
  $("#usr-title").textContent = "Add a user";
  $("#b-uadd").textContent = "Add user";
  $("#b-ucancel").style.display = "none";
  $("#usr-msg").textContent = "";
  $("#u-pin").placeholder = "";
  $("#u-pin2").placeholder = "";
}
function editUser(i){
  const p = profiles[i]; if (!p) return;
  editingUser = p.id;
  $("#u-name").value = p.name || "";
  $("#u-user").value = p.email || "";
  $("#u-user").disabled = true;                 /* the login address itself is not ours to change */
  $("#u-role").value = p.role === "admin" ? "admin" : "operator";
  $("#u-pin").value = ""; $("#u-pin2").value = "";
  $("#u-pin").placeholder = "leave blank to keep";
  $("#u-pin2").placeholder = "leave blank to keep";
  $("#usr-title").textContent = "Edit user";
  $("#b-uadd").textContent = "Save changes";
  $("#b-ucancel").style.display = "";
  $("#usr-msg").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("#u-name").focus();
}

$("#b-uadd").addEventListener("click", async () => {
  if (!isAdmin()) return;
  const msg  = $("#usr-msg");
  const name = $("#u-name").value.trim();
  const user = $("#u-user").value.trim();
  const role = $("#u-role").value;
  const p1   = $("#u-pin").value, p2 = $("#u-pin2").value;
  msg.style.color = "";
  if (!name) return void (msg.textContent = "A name is required.");
  if (!user) return void (msg.textContent = "A username is required.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user))
    return void (msg.textContent = "The username is the person’s work email address.");
  if (p1 !== p2) return void (msg.textContent = "Those two do not match.");
  if (!editingUser && p1.length < 6) return void (msg.textContent = "The password needs at least 6 characters.");

  /* Never leave the app without an administrator. */
  if (editingUser && role !== "admin"){
    const others = profiles.filter(p => p.role === "admin" && p.id !== editingUser).length;
    if (!others) return void (msg.textContent = "Keep at least one administrator.");
  }

  $("#b-uadd").disabled = true;
  msg.textContent = editingUser ? "Saving…" : "Creating the account…";
  try {
    if (editingUser){
      await db.setName(editingUser, name);
      await db.setRole(editingUser, role);
      if (p1) await db.admin("password", { id: editingUser, password: p1 });
      toast("User updated");
    } else {
      const out = await db.admin("create", { name, email: user, password: p1, role });
      toast(out.adopted ? user + " already had a login — access granted" : "Added " + name);
    }
    clearUserForm();
    await refreshProfiles();
  } catch (err){
    msg.style.color = "var(--bad)";
    msg.textContent = err.message;
  } finally { $("#b-uadd").disabled = false; }
});
$("#b-ucancel").addEventListener("click", clearUserForm);

$("#usr-body").addEventListener("click", async e => {
  if (!isAdmin()) return;
  const ed  = e.target.closest("[data-uedit]");
  const del = e.target.closest("[data-udel]");
  if (ed) return editUser(+ed.dataset.uedit);
  if (!del) return;
  const p = profiles[+del.dataset.udel]; if (!p) return;
  if (p.role === "admin" && profiles.filter(x => x.role === "admin").length === 1)
    return void ($("#usr-msg").textContent = "Keep at least one administrator.");
  if (!confirm("Remove " + (p.name || "this user") + "’s access to the label app?\n\n" +
               "Their Meatplus login stays as it is — this only takes away the label app.")) return;
  try {
    await db.admin("revoke", { id: p.id });
    if (editingUser === p.id) clearUserForm();
    toast("Access removed");
    await refreshProfiles();
  } catch (err){ dbErr(err); }
});

$("#b-uexport").addEventListener("click", () => download("users.csv",
  csvRows(["name","username","role","last_signed_in"],
    profiles.map(p => [p.name || "", p.email || "", p.role, p.last_seen ? stampSeen(p.last_seen) : ""])),
  "text/csv"));
