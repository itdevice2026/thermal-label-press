-- Applied to the live project as 20260826...._lbl_activity_trail_admin_only.
--
-- A trail of who did what, readable by administrators only.
--
-- The table has a SELECT policy and nothing else: no insert, no update, no
-- delete, for anybody. A trail that the people in it can rewrite is not a
-- trail. Rows arrive only through lbl_log() below, which is security definer
-- and fills the actor from the session, so nobody can file an entry under
-- someone else's name either.

create table if not exists public.lbl_activity (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid references auth.users(id) on delete set null,
  actor_name   text not null default '',
  action       text not null,
  entity       text not null default '',
  entity_name  text not null default '',
  detail       text not null default ''
);

create index if not exists lbl_activity_at_idx on public.lbl_activity (at desc);

alter table public.lbl_activity enable row level security;

drop policy if exists lbl_activity_read on public.lbl_activity;
create policy lbl_activity_read on public.lbl_activity
  for select using (public.lbl_is_admin());

-- The only way in. Truncation is deliberate: a caller cannot pad the table by
-- sending enormous strings, and the columns stay readable in a list.
create or replace function public.lbl_log(
  p_action text,
  p_entity text default '',
  p_name   text default '',
  p_detail text default ''
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  if not public.lbl_is_staff() then
    return;                      -- a pending account has nothing to record
  end if;
  select name into v_name from public.lbl_profiles where id = auth.uid();
  insert into public.lbl_activity (actor_id, actor_name, action, entity, entity_name, detail)
  values (auth.uid(), coalesce(v_name, ''), left(p_action, 40), left(p_entity, 40),
          left(p_name, 160), left(p_detail, 400));
end $$;

revoke all on function public.lbl_log(text, text, text, text) from public;
grant execute on function public.lbl_log(text, text, text, text) to authenticated;
