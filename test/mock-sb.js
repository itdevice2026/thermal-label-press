/* An in-memory stand-in for supabase-lite, used only by test/index.html.

   It lets the interface be driven end to end — sign in, roles, products,
   printing, the log — without a network, so the label rendering and the
   permission behaviour can be checked in CI. It deliberately mimics the
   server's rules (pending sees nothing, operators cannot write reference
   data) so a test failure means the app is wrong, not the mock. */
(function (global) {
  "use strict";

  const DB = {
    users: [],           /* {id,email,password,name} */
    lbl_profiles: [],
    lbl_customers: [],
    lbl_products: [],
    lbl_print_log: [],
    lbl_settings: [],
    lbl_activity: []
  };
  let seq = 0;
  const uid = () => "id-" + (++seq).toString().padStart(4, "0");

  /* Persisted so a reload behaves like a real server that remembers. */
  const KEY = "mock.db";
  try {
    const raw = localStorage.getItem(KEY);
    if (raw){
      const saved = JSON.parse(raw);
      seq = saved.__seq || 0;
      /* __seq is bookkeeping, not a table. Copying it into DB would let the
         stale value win the Object.assign in persist() below, freezing the id
         counter and handing two people the same id after a reload. */
      Object.keys(saved).forEach(k => { if (k !== "__seq") DB[k] = saved[k]; });
    }
  } catch(e){}
  function persist(){
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign({}, DB, { __seq: seq }))); } catch(e){}
  }

  function table(name){ return DB[name] || (DB[name] = []); }
  function matches(row, match){
    /* only the filters this app uses: id=eq.x, id=gt.0 */
    if (!match) return true;
    return match.split("&").every(part => {
      const [col, rest] = part.split("=");
      const [op, val] = rest.split(".");
      if (op === "eq") return String(row[col]) === val;
      if (op === "gt") return Number(row[col]) > Number(val);
      return true;
    });
  }

  function SBMock(url, key, opts){
    this.storeKey = (opts && opts.storeKey) || "sb.session";
    this.session = null;
    try { const raw = localStorage.getItem(this.storeKey); if (raw) this.session = JSON.parse(raw); } catch(e){}
  }
  const P = SBMock.prototype;

  P._save = function(){
    try {
      if (this.session) localStorage.setItem(this.storeKey, JSON.stringify(this.session));
      else localStorage.removeItem(this.storeKey);
    } catch(e){}
  };
  P.user = function(){ return this.session && this.session.user; };
  P.ensureFresh = async function(){ return this.session; };

  P.rpc = async function(fn, args){
    /* The trail: there is no insert policy on the table, so this function is
       the only way in, and it takes the actor from the session rather than
       from the caller — mirroring lbl_log() on the server. */
    if (fn === "lbl_log"){
      const r = role(this);
      if (r !== "admin" && r !== "operator") return null;   /* pending: nothing to record */
      const u = this.user();
      const p = DB.lbl_profiles.find(x => x.id === u.id) || {};
      DB.lbl_activity.push({
        id: DB.lbl_activity.length + 1,
        at: new Date().toISOString(),
        actor_id: u.id, actor_name: p.name || "",
        action: String((args && args.p_action) || "").slice(0, 40),
        entity: String((args && args.p_entity) || "").slice(0, 40),
        entity_name: String((args && args.p_name) || "").slice(0, 160),
        detail: String((args && args.p_detail) || "").slice(0, 400)
      });
      persist();
      return null;
    }
    if (fn === "lbl_touch"){
      const u = this.user();
      const p = u && DB.lbl_profiles.find(x => x.id === u.id);
      if (p){ p.last_seen = new Date().toISOString(); persist(); }
      return null;
    }
    return null;
  };

  P.signUp = async function(email, password, meta){
    if (!/@meatplus\.ph$/i.test(email)) throw new Error("Sign-up restricted to @meatplus.ph addresses");
    if (DB.users.some(u => u.email === email)) throw new Error("User already registered");
    const u = { id: uid(), email, password, name: (meta && meta.name) || email.split("@")[0] };
    DB.users.push(u);
    DB.lbl_profiles.push({
      id: u.id, name: u.name, email: u.email,
      role: DB.lbl_profiles.length === 0 ? "admin" : "pending",
      created_at: new Date().toISOString(), last_seen: null
    });
    this.session = { access_token: "t-" + u.id, user: { id: u.id, email: u.email } };
    this._save(); persist();
    return this.session;
  };

  P.signIn = async function(email, password){
    const u = DB.users.find(x => x.email === email && x.password === password);
    if (!u) throw new Error("Invalid login credentials");
    this.session = { access_token: "t-" + u.id, user: { id: u.id, email: u.email } };
    this._save();
    return this.session;
  };

  P.signOut = async function(){ this.session = null; this._save(); };

  /* --- the server-side rules, mirrored --- */
  function role(self){
    const u = self.user();
    const p = u && DB.lbl_profiles.find(x => x.id === u.id);
    return p ? p.role : null;
  }
  function requireStaff(self, tbl){
    const r = role(self);
    if (r !== "admin" && r !== "operator") { const e = new Error("permission denied for " + tbl); e.status = 401; throw e; }
  }
  function requireAdmin(self, tbl){
    if (role(self) !== "admin") { const e = new Error("permission denied for " + tbl); e.status = 401; throw e; }
  }
  const REFERENCE = ["lbl_customers","lbl_products","lbl_settings"];
  const APPROVABLE = ["lbl_customers","lbl_products"];

  P.select = async function(tbl, query){
    const q = query || "";
    if (tbl === "lbl_profiles"){
      const u = this.user();
      const mine = DB.lbl_profiles.filter(p => p.id === (u && u.id));
      const rows = role(this) === "admin" ? DB.lbl_profiles.slice() : mine;
      const m = /id=eq\.([^&]+)/.exec(q);
      return m ? rows.filter(r => r.id === m[1]) : rows;
    }
    const r = role(this);
    if (tbl === "lbl_activity"){
      if (r !== "admin") return [];                        /* the trail is administrators only */
      const rows = table(tbl).slice().sort((a,b) =>
        (b.at || "").localeCompare(a.at || "") || (b.id - a.id));
      const m = /limit=(\d+)/.exec(q);
      return m ? rows.slice(0, +m[1]) : rows;
    }
    if (r !== "admin" && r !== "operator") return [];      /* pending / signed out see nothing */
    let rows = table(tbl).slice();
    const m = /id=eq\.([^&]+)/.exec(q);
    if (m) rows = rows.filter(x => String(x.id) === m[1]);
    if (/order=name\.asc/.test(q)) rows.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    if (/order=printed_at\.desc/.test(q)) rows.sort((a,b) => (b.printed_at||"").localeCompare(a.printed_at||""));
    return rows;
  };

  P.insert = async function(tbl, rows){
    /* the trail has no policy for this — not even for an administrator */
    if (tbl === "lbl_activity"){ const e = new Error("permission denied for lbl_activity"); e.status = 401; throw e; }
    /* Operators may propose a product or customer, but only as pending and
       only under their own name — mirrors the row-level policies. */
    if (APPROVABLE.indexOf(tbl) >= 0 && role(this) === "operator"){
      const u = this.user();
      rows.forEach(r => {
        if (r.status !== "pending" || r.created_by !== (u && u.id)){
          const e = new Error("new row violates row-level security policy"); e.status = 401; throw e;
        }
      });
    }
    else if (REFERENCE.indexOf(tbl) >= 0) requireAdmin(this, tbl);
    else requireStaff(this, tbl);
    const out = rows.map(r => {
      const row = Object.assign({ id: uid() }, r);
      if (tbl === "lbl_print_log"){
        if (row.by_id !== this.user().id){ const e = new Error("new row violates row-level security"); e.status = 401; throw e; }
        row.printed_at = new Date().toISOString();
      }
      if (tbl === "lbl_products" && table(tbl).some(x => x.code === row.code))
        throw new Error("duplicate key value violates unique constraint");
      table(tbl).push(row);
      return row;
    });
    persist();
    return out;
  };

  P.upsert = async function(tbl, rows, onConflict){
    requireAdmin(this, tbl);
    const res = rows.map(r => {
      const key = onConflict || "id";
      const hit = table(tbl).find(x => x[key] === r[key]);
      if (hit){ Object.assign(hit, r); return hit; }
      const row = Object.assign({ id: r.id || uid() }, r);
      table(tbl).push(row);
      return row;
    });
    persist();
    return res;
  };

  P.update = async function(tbl, match, patch){
    /* The trail has no update policy, for anybody. PostgREST answers a write
       that row-level security filters away with success and no rows, not an
       error — so the thing to check is that nothing changed, not that it threw. */
    if (tbl === "lbl_activity") return [];
    if (APPROVABLE.indexOf(tbl) >= 0 && role(this) === "operator"){
      const u = this.user();
      const rows = table(tbl).filter(r => matches(r, match));
      const mine = rows.filter(r => r.created_by === (u && u.id) && r.status === "pending");
      /* A row policy cannot restrict columns; staying pending is the check. */
      if (mine.length !== rows.length || (patch.status && patch.status !== "pending")){
        const e = new Error("new row violates row-level security policy"); e.status = 401; throw e;
      }
      mine.forEach(r => Object.assign(r, patch));
      persist();
      return mine;
    }
    if (tbl === "lbl_profiles") requireAdmin(this, tbl);
    else if (REFERENCE.indexOf(tbl) >= 0) requireAdmin(this, tbl);
    else requireStaff(this, tbl);
    const hit = table(tbl).filter(r => matches(r, match));
    hit.forEach(r => Object.assign(r, patch));
    persist();
    return hit;
  };

  P.remove = async function(tbl, match){
    if (tbl === "lbl_activity") return [];        /* no delete policy either */
    if (APPROVABLE.indexOf(tbl) >= 0 && role(this) === "operator"){
      const u = this.user();
      const rows = table(tbl).filter(r => matches(r, match));
      const mine = rows.filter(r => r.created_by === (u && u.id) && r.status === "pending");
      if (mine.length !== rows.length){ const e = new Error("permission denied"); e.status = 401; throw e; }
      DB[tbl] = table(tbl).filter(r => mine.indexOf(r) < 0);
      persist();
      return mine;
    }
    requireAdmin(this, tbl);
    const keep = [], gone = [];
    table(tbl).forEach(r => (matches(r, match) ? gone : keep).push(r));
    if (tbl === "lbl_customers"){
      gone.forEach(c => {
        if (DB.lbl_products.some(p => p.customer_id === c.id))
          throw new Error("update or delete violates foreign key constraint");
      });
    }
    DB[tbl] = keep;
    persist();
    return gone;
  };

  /* ---------------------------------------------------------------------
     The lbl-users Edge Function, stood in for.

     The real one holds the service-role key and refuses anyone who is not an
     administrator. The stand-in mirrors that refusal exactly, so a test that
     passes here would also have been refused by the server — and the app's
     own fetch code is the code under test, unchanged.
     --------------------------------------------------------------------- */
  const realFetch = global.fetch.bind(global);
  global.fetch = function(url, init){
    if (String(url).indexOf("/functions/v1/lbl-users") < 0) return realFetch(url, init);

    const json = (body, status) => Promise.resolve({
      ok: status < 400, status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    });

    const auth = (init && init.headers && init.headers.Authorization) || "";
    const token = auth.replace(/^Bearer\s+/, "");
    const caller = DB.users.find(u => ("t-" + u.id) === token);
    if (!caller) return json({ error: "Not signed in" }, 401);
    const cp = DB.lbl_profiles.find(p => p.id === caller.id);
    if (!cp || cp.role !== "admin") return json({ error: "Only an administrator can manage accounts" }, 403);

    let body = {};
    try { body = JSON.parse((init && init.body) || "{}"); } catch(e){}

    if (body.action === "create"){
      const email = String(body.email || "").toLowerCase();
      const name  = String(body.name || "").trim();
      const pass  = String(body.password || "");
      const role  = ["admin","operator","pending"].indexOf(body.role) >= 0 ? body.role : "operator";
      if (!name)  return json({ error: "A name is required" }, 400);
      if (!email) return json({ error: "A username is required" }, 400);
      let u = DB.users.find(x => x.email.toLowerCase() === email);
      const adopted = !!u;
      if (u){ if (pass) u.password = pass; }
      else {
        if (pass.length < 6) return json({ error: "The password needs at least 6 characters" }, 400);
        u = { id: uid(), email, password: pass, name };
        DB.users.push(u);
      }
      const hit = DB.lbl_profiles.find(p => p.id === u.id);
      if (hit) Object.assign(hit, { name, email, role });
      else DB.lbl_profiles.push({ id: u.id, name, email, role, created_at: new Date().toISOString(), last_seen: null });
      persist();
      return json({ ok: true, id: u.id, adopted }, 200);
    }

    if (body.action === "password"){
      const u = DB.users.find(x => x.id === body.id);
      if (!u) return json({ error: "Which account?" }, 400);
      if (String(body.password || "").length < 6) return json({ error: "The password needs at least 6 characters" }, 400);
      u.password = body.password; persist();
      return json({ ok: true }, 200);
    }

    if (body.action === "revoke"){
      if (body.id === caller.id) return json({ error: "You cannot remove your own access" }, 400);
      DB.lbl_profiles = DB.lbl_profiles.filter(p => p.id !== body.id);
      persist();
      return json({ ok: true }, 200);
    }
    return json({ error: "Unknown action" }, 400);
  };

  global.SB = SBMock;
  global.__DB = DB;          /* tests read this to check what was written */
})(window);
