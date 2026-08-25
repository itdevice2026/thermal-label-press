/* ---------------------------------------------------------------------------
   supabase-lite — the small slice of Supabase this app actually uses.

   Written by hand instead of pulling supabase-js from a CDN so the page stays
   two files and one network origin: no third-party script, nothing to go stale,
   and the whole client is auditable in one screen.

   Covers: email/password sign-up and sign-in, session refresh, sign-out, and
   PostgREST select / insert / update / delete. Row-level security in the
   database is what actually enforces permissions — this client only carries the
   caller's token.
   --------------------------------------------------------------------------- */
(function (global) {
  "use strict";

  function SB(url, key, opts) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
    this.storeKey = (opts && opts.storeKey) || "sb.session";
    this.session = null;
    this.onSignOut = null;
    try {
      const raw = localStorage.getItem(this.storeKey);
      if (raw) this.session = JSON.parse(raw);
    } catch (e) {}
  }

  SB.prototype._save = function () {
    try {
      if (this.session) localStorage.setItem(this.storeKey, JSON.stringify(this.session));
      else localStorage.removeItem(this.storeKey);
    } catch (e) {}
  };

  SB.prototype._setSession = function (s) {
    if (s && s.access_token) {
      this.session = {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
        user: s.user || (this.session && this.session.user) || null
      };
    } else {
      this.session = null;
    }
    this._save();
    return this.session;
  };

  SB.prototype.user = function () { return this.session && this.session.user; };

  /* An error shaped the same way whatever went wrong, so callers branch on one thing. */
  function fail(status, body) {
    const msg = (body && (body.error_description || body.msg || body.message || body.error ||
                 body.hint || body.details)) || ("Request failed (" + status + ")");
    const e = new Error(msg);
    e.status = status;
    e.body = body;
    return e;
  }

  SB.prototype._fetch = async function (path, init) {
    init = init || {};
    const headers = Object.assign({ apikey: this.key }, init.headers || {});
    if (this.session && this.session.access_token && !headers.Authorization) {
      headers.Authorization = "Bearer " + this.session.access_token;
    }
    let res;
    try {
      res = await fetch(this.url + path, Object.assign({}, init, { headers }));
    } catch (e) {
      throw fail(0, { message: "Can’t reach the server. Check the internet connection." });
    }
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = { message: text }; } }
    if (!res.ok) throw fail(res.status, body);
    return body;
  };

  /* Refresh a little before expiry so a long shift doesn't get bounced mid-print. */
  SB.prototype.ensureFresh = async function () {
    const s = this.session;
    if (!s) return null;
    if (s.expires_at && s.expires_at - 60 > Math.floor(Date.now() / 1000)) return s;
    if (!s.refresh_token) { this._setSession(null); return null; }
    try {
      const out = await this._fetch("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      return this._setSession(out);
    } catch (e) {
      this._setSession(null);
      if (this.onSignOut) this.onSignOut();
      return null;
    }
  };

  SB.prototype.signUp = async function (email, password, meta) {
    const out = await this._fetch("/auth/v1/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, data: meta || {} })
    });
    /* With email confirmation switched on there is no session yet — that is not an error. */
    if (out && out.access_token) this._setSession(out);
    return out;
  };

  SB.prototype.signIn = async function (email, password) {
    const out = await this._fetch("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    return this._setSession(out);
  };

  SB.prototype.signOut = async function () {
    if (this.session) {
      try { await this._fetch("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    }
    this._setSession(null);
  };

  SB.prototype.resetPassword = function (email, redirectTo) {
    return this._fetch("/auth/v1/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, gotrue_meta_security: {}, redirect_to: redirectTo })
    });
  };

  SB.prototype.updateUser = async function (attrs) {
    await this.ensureFresh();
    return this._fetch("/auth/v1/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attrs)
    });
  };

  /* ---- PostgREST ---- */
  SB.prototype.select = async function (table, query) {
    await this.ensureFresh();
    const q = query ? (query.indexOf("select=") < 0 ? "select=*&" + query : query) : "select=*";
    return this._fetch("/rest/v1/" + table + "?" + q, { method: "GET" });
  };

  SB.prototype.insert = async function (table, rows) {
    await this.ensureFresh();
    return this._fetch("/rest/v1/" + table, {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(rows)
    });
  };

  SB.prototype.upsert = async function (table, rows, onConflict) {
    await this.ensureFresh();
    const path = "/rest/v1/" + table + (onConflict ? "?on_conflict=" + onConflict : "");
    return this._fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(rows)
    });
  };

  SB.prototype.update = async function (table, match, patch) {
    await this.ensureFresh();
    return this._fetch("/rest/v1/" + table + "?" + match, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(patch)
    });
  };

  /* Calls a database function. Used for the narrow writes a policy cannot
     express — stamping last-seen without opening the whole row to editing. */
  SB.prototype.rpc = async function (fn, args) {
    await this.ensureFresh();
    return this._fetch("/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {})
    });
  };

  SB.prototype.remove = async function (table, match) {
    await this.ensureFresh();
    return this._fetch("/rest/v1/" + table + "?" + match, {
      method: "DELETE",
      headers: { Prefer: "return=representation" }
    });
  };

  global.SB = SB;
})(window);
