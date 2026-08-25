-- Applied to the live project as 20260825111944_lbl_operator_submissions_need_approval.
--
-- Operators may now propose products and customers; an administrator approves
-- them before they can be used. A pending row exists but is invisible to the
-- Print tab, so nothing reaches a pack until someone with authority has looked.

alter table public.lbl_products
  add column if not exists status       text not null default 'approved',
  add column if not exists created_by   uuid references auth.users(id) on delete set null,
  add column if not exists submitted_at timestamptz;

alter table public.lbl_customers
  add column if not exists status       text not null default 'approved',
  add column if not exists created_by   uuid references auth.users(id) on delete set null,
  add column if not exists submitted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lbl_products_status_ck') then
    alter table public.lbl_products
      add constraint lbl_products_status_ck check (status in ('approved','pending'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lbl_customers_status_ck') then
    alter table public.lbl_customers
      add constraint lbl_customers_status_ck check (status in ('approved','pending'));
  end if;
end $$;

-- Everything that already exists was created by an administrator.
update public.lbl_products  set status = 'approved' where status is distinct from 'approved';
update public.lbl_customers set status = 'approved' where status is distinct from 'approved';

/* ---------------------------------------------------------------------------
   Products
   --------------------------------------------------------------------------- */
drop policy if exists lbl_products_admin_insert  on public.lbl_products;
drop policy if exists lbl_products_admin_update  on public.lbl_products;
drop policy if exists lbl_products_admin_delete  on public.lbl_products;
drop policy if exists lbl_products_op_insert     on public.lbl_products;
drop policy if exists lbl_products_op_update     on public.lbl_products;
drop policy if exists lbl_products_op_delete     on public.lbl_products;

create policy lbl_products_admin_insert on public.lbl_products
  for insert with check (public.lbl_is_admin());
create policy lbl_products_admin_update on public.lbl_products
  for update using (public.lbl_is_admin()) with check (public.lbl_is_admin());
create policy lbl_products_admin_delete on public.lbl_products
  for delete using (public.lbl_is_admin());

-- An operator may only ever file a proposal, under their own name.
create policy lbl_products_op_insert on public.lbl_products
  for insert with check (
    public.lbl_is_staff() and status = 'pending' and created_by = auth.uid()
  );
-- They may correct their own proposal, but WITH CHECK keeps it pending —
-- a row policy cannot restrict columns, so approving oneself is blocked by
-- requiring the row to still be pending after the write.
create policy lbl_products_op_update on public.lbl_products
  for update using (created_by = auth.uid() and status = 'pending')
          with check (created_by = auth.uid() and status = 'pending');
create policy lbl_products_op_delete on public.lbl_products
  for delete using (created_by = auth.uid() and status = 'pending');

/* ---------------------------------------------------------------------------
   Customers — same shape
   --------------------------------------------------------------------------- */
drop policy if exists lbl_customers_admin_insert on public.lbl_customers;
drop policy if exists lbl_customers_admin_update on public.lbl_customers;
drop policy if exists lbl_customers_admin_delete on public.lbl_customers;
drop policy if exists lbl_customers_op_insert    on public.lbl_customers;
drop policy if exists lbl_customers_op_update    on public.lbl_customers;
drop policy if exists lbl_customers_op_delete    on public.lbl_customers;

create policy lbl_customers_admin_insert on public.lbl_customers
  for insert with check (public.lbl_is_admin());
create policy lbl_customers_admin_update on public.lbl_customers
  for update using (public.lbl_is_admin()) with check (public.lbl_is_admin());
create policy lbl_customers_admin_delete on public.lbl_customers
  for delete using (public.lbl_is_admin());

create policy lbl_customers_op_insert on public.lbl_customers
  for insert with check (
    public.lbl_is_staff() and status = 'pending' and created_by = auth.uid()
  );
create policy lbl_customers_op_update on public.lbl_customers
  for update using (created_by = auth.uid() and status = 'pending')
          with check (created_by = auth.uid() and status = 'pending');
create policy lbl_customers_op_delete on public.lbl_customers
  for delete using (created_by = auth.uid() and status = 'pending');
