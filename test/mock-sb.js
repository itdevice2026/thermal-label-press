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
    lbl_settings: []
  };
  let seq = 0;
  const uid = () => "id-" + (++seq).toString().padStart(4, "0");

  /* Persisted so a reload behaves like a real server that remembers. */
  const KEY = "mock.db";
  try {
    const raw = localStorage.getItem(KEY);
    if (raw){ const saved = JSON.parse(raw); Object.keys(saved).forEach(k => DB[k] = saved[k]); seq = saved.__seq || 0; }
  } catch(e){}
  function persist(){
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign({ __seq: seq }, DB))); } catch(e){}
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

  P.signUp = async function(email, password, meta){
    if (!/@meatplus\.ph$/i.test(email)) throw new Error("Sign-up restricted to @meatplus.ph addresses");
    if (DB.users.some(u => u.email === email)) throw new Error("User already registered");
    const u = { id: uid(), email, password, name: (meta && meta.name) || email.split("@")[0] };
    DB.users.push(u);
    DB.lbl_profiles.push({
      id: u.id, name: u.name,
      role: DB.lbl_profiles.length === 0 ? "admin" : "pending",
      created_at: new Date().toISOString()
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
    if (r !== "admin" && r !== "operator") return [];      /* pending / signed out see nothing */
    let rows = table(tbl).slice();
    const m = /id=eq\.([^&]+)/.exec(q);
    if (m) rows = rows.filter(x => String(x.id) === m[1]);
    if (/order=name\.asc/.test(q)) rows.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    if (/order=printed_at\.desc/.test(q)) rows.sort((a,b) => (b.printed_at||"").localeCompare(a.printed_at||""));
    return rows;
  };

  P.insert = async function(tbl, rows){
    if (REFERENCE.indexOf(tbl) >= 0) requireAdmin(this, tbl);
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
    if (tbl === "lbl_profiles") requireAdmin(this, tbl);
    else if (REFERENCE.indexOf(tbl) >= 0) requireAdmin(this, tbl);
    else requireStaff(this, tbl);
    const hit = table(tbl).filter(r => matches(r, match));
    hit.forEach(r => Object.assign(r, patch));
    persist();
    return hit;
  };

  P.remove = async function(tbl, match){
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

  global.SB = SBMock;
  global.__DB = DB;          /* tests read this to check what was written */
})(window);
