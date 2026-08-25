-- Thermal Label Press — customer-based barcode label generator
-- Applied to the shared Supabase project (migration 20260825032453).
-- Every object is prefixed lbl_ so it sits alongside the other apps in the
-- same database.
--
-- The rules this file encodes:
--   pending    can sign in and see nothing
--   operator   reads everything, appends print-log rows under their own name
--   admin      the above, plus writes products, customers, settings and roles

create table if not exists public.lbl_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  role       text not null default 'pending' check (role in ('admin','operator','pending')),
  created_at timestamptz not null default now()
);

-- security definer so policies can ask "is the caller an admin?" without recursing into lbl_profiles
create or replace function public.lbl_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lbl_profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.lbl_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lbl_profiles p where p.id = auth.uid() and p.role in ('admin','operator'));
$$;

-- every new sign-up gets a profile; the very first one runs the place
create or replace function public.lbl_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.lbl_profiles) into first_user;
  insert into public.lbl_profiles (id, name, role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          case when first_user then 'admin' else 'pending' end)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists lbl_on_auth_user_created on auth.users;
create trigger lbl_on_auth_user_created
  after insert on auth.users
  for each row execute function public.lbl_handle_new_user();

create table if not exists public.lbl_customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null default '',
  contact    text not null default '',
  address    text not null default '',
  notes      text not null default '',
  stock      jsonb,                       -- this customer's own label stock, null = house default
  created_at timestamptz not null default now()
);
create unique index if not exists lbl_customers_name_key on public.lbl_customers (lower(name));

create table if not exists public.lbl_products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  size        text not null default '',
  code        text not null unique,
  customer_id uuid not null references public.lbl_customers(id) on delete restrict,
  created_at  timestamptz not null default now()
);
create index if not exists lbl_products_customer_idx on public.lbl_products (customer_id);

create table if not exists public.lbl_print_log (
  id            bigint generated always as identity primary key,
  printed_at    timestamptz not null default now(),
  by_id         uuid references auth.users(id) on delete set null,
  by_name       text not null default '',
  customer_name text not null default '',
  product_name  text not null default '',
  size          text not null default '',
  code          text not null default '',
  pd            date,
  ed            date,
  copies        integer not null default 1
);
create index if not exists lbl_print_log_time_idx on public.lbl_print_log (printed_at desc);

create table if not exists public.lbl_settings (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.lbl_profiles  enable row level security;
alter table public.lbl_customers enable row level security;
alter table public.lbl_products  enable row level security;
alter table public.lbl_print_log enable row level security;
alter table public.lbl_settings  enable row level security;

-- profiles: you see yourself; admins see and manage everyone
drop policy if exists lbl_profiles_select on public.lbl_profiles;
create policy lbl_profiles_select on public.lbl_profiles for select to authenticated
  using (id = auth.uid() or public.lbl_is_admin());
drop policy if exists lbl_profiles_update_self on public.lbl_profiles;
create policy lbl_profiles_update_self on public.lbl_profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.lbl_profiles p where p.id = auth.uid()));
drop policy if exists lbl_profiles_admin_update on public.lbl_profiles;
create policy lbl_profiles_admin_update on public.lbl_profiles for update to authenticated
  using (public.lbl_is_admin()) with check (public.lbl_is_admin());
drop policy if exists lbl_profiles_admin_delete on public.lbl_profiles;
create policy lbl_profiles_admin_delete on public.lbl_profiles for delete to authenticated
  using (public.lbl_is_admin() and id <> auth.uid());

-- reference data: staff read, admins write
drop policy if exists lbl_customers_read on public.lbl_customers;
create policy lbl_customers_read on public.lbl_customers for select to authenticated using (public.lbl_is_staff());
drop policy if exists lbl_customers_write on public.lbl_customers;
create policy lbl_customers_write on public.lbl_customers for all to authenticated
  using (public.lbl_is_admin()) with check (public.lbl_is_admin());

drop policy if exists lbl_products_read on public.lbl_products;
create policy lbl_products_read on public.lbl_products for select to authenticated using (public.lbl_is_staff());
drop policy if exists lbl_products_write on public.lbl_products;
create policy lbl_products_write on public.lbl_products for all to authenticated
  using (public.lbl_is_admin()) with check (public.lbl_is_admin());

drop policy if exists lbl_settings_read on public.lbl_settings;
create policy lbl_settings_read on public.lbl_settings for select to authenticated using (public.lbl_is_staff());
drop policy if exists lbl_settings_write on public.lbl_settings;
create policy lbl_settings_write on public.lbl_settings for all to authenticated
  using (public.lbl_is_admin()) with check (public.lbl_is_admin());

-- print log: staff read and append their own runs; only admins clear it
drop policy if exists lbl_log_read on public.lbl_print_log;
create policy lbl_log_read on public.lbl_print_log for select to authenticated using (public.lbl_is_staff());
drop policy if exists lbl_log_insert on public.lbl_print_log;
create policy lbl_log_insert on public.lbl_print_log for insert to authenticated
  with check (public.lbl_is_staff() and by_id = auth.uid());
drop policy if exists lbl_log_delete on public.lbl_print_log;
create policy lbl_log_delete on public.lbl_print_log for delete to authenticated using (public.lbl_is_admin());
