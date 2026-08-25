/* ---------------------------------------------------------------------------
   lbl-users — the only place with enough privilege to make an account.

   The Users tab needs to do three things a browser must never be trusted with:
   create a login with a password, change someone's password, and take access
   away. Doing any of that requires the project's service-role key, which grants
   unrestricted access to every table in this project — including the other
   apps that share it. A key like that cannot live in a page anyone can view
   the source of.

   So it lives here instead. Every request is checked twice before anything
   happens: the caller must present a valid session, and that caller must be an
   administrator according to lbl_profiles. The browser only ever sends the
   caller's own ordinary token.

   JWT verification is done in here rather than at the gateway so the browser's
   CORS preflight (which carries no token) is not rejected before it arrives.
   --------------------------------------------------------------------------- */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* The page is served from GitHub Pages, a different origin to this function. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const ROLES = ["admin", "operator", "pending"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return reply({ error: "Use POST" }, 405);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  /* ---- 1. who is asking? ---- */
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Not signed in" }, 401);

  const { data: caller, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !caller?.user) return reply({ error: "Not signed in" }, 401);

  /* ---- 2. are they allowed? ---- */
  const { data: prof } = await admin
    .from("lbl_profiles").select("role").eq("id", caller.user.id).maybeSingle();
  if (!prof || prof.role !== "admin") {
    return reply({ error: "Only an administrator can manage accounts" }, 403);
  }

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }
  const action = String(body.action || "");

  try {
    /* -----------------------------------------------------------------
       create — make the login, or adopt one that already exists.

       This project's auth is shared with other Meatplus apps, so an email
       may already have a login. In that case we do not make a second one:
       we give the existing person access to the label app, and only touch
       their password if a new one was actually typed.
       ----------------------------------------------------------------- */
    if (action === "create") {
      const name  = String(body.name  || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const pass  = String(body.password || "");
      const role  = ROLES.includes(String(body.role)) ? String(body.role) : "operator";
      if (!name)  return reply({ error: "A name is required" }, 400);
      if (!email) return reply({ error: "A username is required" }, 400);

      /* Look for an existing login with this address. */
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users?.find(u => (u.email || "").toLowerCase() === email);

      let id: string;
      let adopted = false;

      if (existing) {
        id = existing.id;
        adopted = true;
        if (pass) {
          const { error } = await admin.auth.admin.updateUserById(id, { password: pass });
          if (error) return reply({ error: error.message }, 400);
        }
      } else {
        if (pass.length < 6) return reply({ error: "The password needs at least 6 characters" }, 400);
        const { data: made, error } = await admin.auth.admin.createUser({
          email, password: pass, email_confirm: true, user_metadata: { name },
        });
        if (error || !made?.user) return reply({ error: error?.message || "Could not create the account" }, 400);
        id = made.user.id;
      }

      /* The signup trigger may have written a row already; settle it either way. */
      const { error: upErr } = await admin.from("lbl_profiles")
        .upsert({ id, name, email, role }, { onConflict: "id" });
      if (upErr) return reply({ error: upErr.message }, 400);

      return reply({ ok: true, id, adopted });
    }

    /* ---- password — set a new one for someone who forgot theirs ---- */
    if (action === "password") {
      const id   = String(body.id || "");
      const pass = String(body.password || "");
      if (!id) return reply({ error: "Which account?" }, 400);
      if (pass.length < 6) return reply({ error: "The password needs at least 6 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password: pass });
      if (error) return reply({ error: error.message }, 400);
      return reply({ ok: true });
    }

    /* -----------------------------------------------------------------
       revoke — take away access to the label app.

       Deliberately NOT a deletion of the login. That login is shared with
       the other apps in this project, and deleting it here would lock the
       person out of all of them. Removing the profile row is what takes
       away access to this app, and only this app.
       ----------------------------------------------------------------- */
    if (action === "revoke") {
      const id = String(body.id || "");
      if (!id) return reply({ error: "Which account?" }, 400);
      if (id === caller.user.id) return reply({ error: "You cannot remove your own access" }, 400);
      const { error } = await admin.from("lbl_profiles").delete().eq("id", id);
      if (error) return reply({ error: error.message }, 400);
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500);
  }
});
