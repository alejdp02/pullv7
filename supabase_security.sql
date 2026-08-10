-- Phoenix Pull v5 security hardening
-- Run this in Supabase SQL Editor AFTER confirming the table/column names match your project.
-- The browser only has the anon key; authorization must be enforced here with RLS.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and coalesce(p.active, true) = true
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Protect privileged profile fields from normal users.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if auth.uid() is distinct from old.id then
      raise exception 'You may only modify your own profile';
    end if;
    if new.id is distinct from old.id
       or new.email is distinct from old.email
       or new.role is distinct from old.role
       or new.active is distinct from old.active then
      raise exception 'Only administrators may change profile identity, role, or active status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_profile_fields on public.profiles;
create trigger trg_protect_profile_fields
before update on public.profiles
for each row execute function public.protect_profile_fields();

-- Profiles
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert to authenticated
with check (
  (id = auth.uid() and role = 'user' and coalesce(active, true) = true)
  or public.is_admin()
);

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles for update to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

-- Items: normal users see active items; admins can manage everything.
alter table public.items enable row level security;
drop policy if exists "items_select_active_or_admin" on public.items;
create policy "items_select_active_or_admin"
on public.items for select to authenticated
using (coalesce(active, true) = true or public.is_admin());

drop policy if exists "items_admin_insert" on public.items;
create policy "items_admin_insert"
on public.items for insert to authenticated
with check (public.is_admin());

drop policy if exists "items_admin_update" on public.items;
create policy "items_admin_update"
on public.items for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "items_admin_delete" on public.items;
create policy "items_admin_delete"
on public.items for delete to authenticated
using (public.is_admin());

-- Quantities are strictly per-user.
alter table public.quantities enable row level security;
drop policy if exists "quantities_own_select" on public.quantities;
create policy "quantities_own_select"
on public.quantities for select to authenticated
using (user_id = auth.uid());

drop policy if exists "quantities_own_insert" on public.quantities;
create policy "quantities_own_insert"
on public.quantities for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists "quantities_own_update" on public.quantities;
create policy "quantities_own_update"
on public.quantities for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "quantities_own_delete" on public.quantities;
create policy "quantities_own_delete"
on public.quantities for delete to authenticated
using (user_id = auth.uid());

-- Interactions: users can write their own events; only admins can read/delete all logs.
alter table public.interactions enable row level security;
drop policy if exists "interactions_insert_own" on public.interactions;
create policy "interactions_insert_own"
on public.interactions for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists "interactions_select_admin" on public.interactions;
create policy "interactions_select_admin"
on public.interactions for select to authenticated
using (public.is_admin());

drop policy if exists "interactions_delete_admin" on public.interactions;
create policy "interactions_delete_admin"
on public.interactions for delete to authenticated
using (public.is_admin());

-- Recommended uniqueness for the client upsert target.
create unique index if not exists quantities_user_category_item_key
on public.quantities (user_id, category, item_name);
