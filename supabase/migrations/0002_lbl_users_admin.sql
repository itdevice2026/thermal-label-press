-- The Users tab, brought into line with the offline build.
--
-- Offline, an administrator types a colleague's name, username, role and PIN
-- and the account exists. Doing the same against a real auth server needs two
-- things the first migration did not provide: the Users table has to be able
-- to show a username and a last-signed-in time, and something has to be
-- allowed to create a login. The first is here; the second is the lbl-users
-- Edge Function (supabase/functions/lbl-users), which holds the service-role
-- key server-side and refuses anyone who is not an administrator.

-- ---------------------------------------------------------------------------
-- Username and last signed in
--
-- auth.users is not reachable from a browser through PostgREST, so the app
-- keeps its own copy of the two fields the Users table displays.
-- ---------------------------------------------------------------------------
alter table public.lbl_profiles
  add column if not exists email     text,
  add column if not exists last_seen timestamptz;

update public.lbl_profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and p.email is distinct from u.email;

-- ---------------------------------------------------------------------------
-- Stamping last-seen
--
-- A row-level policy cannot say WHICH COLUMNS an update may touch. A policy
-- permissive enough to let someone write their own last_seen would also let
-- them write their own role, so the stamp goes through a function narrow
-- enough that it can only ever do the one thing.
-- ---------------------------------------------------------------------------
create or replace function public.lbl_touch()
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.lbl_profiles set last_seen = now() where id = auth.uid();
$$;

revoke all on function public.lbl_touch() from public;
grant execute on function public.lbl_touch() to authenticated;

-- ---------------------------------------------------------------------------
-- Invites
--
-- A role can be set aside before the person has ever signed in, so someone
-- expected on the line starts as an Operator rather than sitting on the
-- Waiting for approval screen.
-- ---------------------------------------------------------------------------
create table if not exists public.lbl_invites (
  email      text primary key,
  name       text not null default '',
  role       text not null default 'operator' check (role in ('admin','operator','pending')),
  created_at timestamptz not null default now()
);
alter table public.lbl_invites enable row level security;

drop policy if exists lbl_invites_admin_all on public.lbl_invites;
create policy lbl_invites_admin_all on public.lbl_invites
  for all using (public.lbl_is_admin()) with check (public.lbl_is_admin());

-- ---------------------------------------------------------------------------
-- Sign-up now carries the email across and honours an invite.
-- The first account ever created is still the administrator.
-- ---------------------------------------------------------------------------
create or replace function public.lbl_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare first_user boolean; invited record;
begin
  select not exists (select 1 from public.lbl_profiles) into first_user;
  select * into invited from public.lbl_invites i where lower(i.email) = lower(new.email) limit 1;

  insert into public.lbl_profiles (id, name, email, role)
  values (new.id,
          coalesce(invited.name, new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          new.email,
          case when first_user then 'admin'
               when invited.role is not null then invited.role
               else 'pending' end)
  on conflict (id) do nothing;

  delete from public.lbl_invites where lower(email) = lower(new.email);
  return new;
end;
$$;
