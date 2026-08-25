/* Where this copy of the app keeps its data.

   The publishable key is meant to be public — it identifies the project, it does
   not grant access. What a signed-in person can read or change is decided by the
   row-level security policies in supabase/migrations, on the server, where it
   cannot be edited from a browser. */
window.LBL_CONFIG = {
  SUPABASE_URL: "https://emkcwukiqxnvcbhkjiqz.supabase.co",
  SUPABASE_KEY: "sb_publishable_u_qnmEI8oHI9Z_A0-Hht3Q_Yvaa7Ork",

  /* Sign-ups on this project are restricted to @meatplus.ph addresses by a
     database trigger. The first account ever created becomes the administrator;
     everyone after that lands as "pending" and sees nothing until an
     administrator gives them a role. */
  SIGNUP_DOMAIN: "meatplus.ph"
};
