Phoenix Pull v4 — fresh rebuild

This app reuses your existing Supabase project + config.js.

Tables used (same names as your previous app):
- profiles: id (uuid), email, display_name, role ('admin'/'user'), active (bool), created_at
- items: id (uuid or int), category (text), name (text), note (text), shelf (text), par (int), active (bool), updated_at
- quantities: user_id (uuid), category (text), item_name (text), qty (int), restock (bool), updated_at
- interactions: created_at, user_id, user_email, action, payload (json)

IMPORTANT SECURITY NOTE:
Admin-only features must be protected by Supabase RLS. The UI hides admin tools, but real security is RLS.

If you haven't created 'items' yet, create it in Supabase and enable RLS:
(Adjust types as you prefer)

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  note text,
  shelf text,
  par int,
  active boolean not null default true,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- suggested unique constraint
create unique index if not exists items_unique on public.items(category, name);

alter table public.items enable row level security;

-- everyone signed in can read items
create policy "items_read" on public.items
for select to authenticated
using (true);

-- only admins can insert/update/delete (depends on profiles.role)
create policy "items_admin_write" on public.items
for all to authenticated
using (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
))
with check (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
));

Repeat similar patterns for profiles/interactions if you want hard security there too.
