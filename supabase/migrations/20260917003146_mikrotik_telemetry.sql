-- Latest snapshot only: bounded storage, no router credentials or arbitrary jobs.
create table public.mikrotik_snapshots (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  router_key text not null check (router_key = 'local-test'),
  received_at timestamptz not null default now(),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  primary key (organization_id, router_key)
);
alter table public.mikrotik_snapshots enable row level security;
revoke all on public.mikrotik_snapshots from public, anon, authenticated;
grant select on public.mikrotik_snapshots to authenticated;
grant select, insert, update, delete on public.mikrotik_snapshots to service_role;
create policy admin_read_router_snapshot on public.mikrotik_snapshots
  for select to authenticated using (
    exists (select 1 from public.memberships m
      where m.user_id = (select auth.uid())
        and m.organization_id = mikrotik_snapshots.organization_id
        and m.role = 'admin' and m.status = 'active')
  );
