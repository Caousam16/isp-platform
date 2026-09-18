-- An admin confirms the customer-to-IP mapping; never infer it from a plan name.
-- Invalidate pending jobs created under the previous zero-burst test profile.
-- In-flight writes remain untouched and must finish or be reconciled manually.
update public.mikrotik_bandwidth_jobs
  set status='expired', finished_at=now(), result_code='profile_replaced'
  where status='pending';
create table public.mikrotik_subscriber_queues (
  organization_id uuid not null references public.organizations(id),
  subscriber_id uuid not null,
  router_key text not null default 'local-test' check (router_key='local-test'),
  queue_id text not null check (queue_id ~ '^\*[0-9A-Fa-f]+$'),
  queue_name text not null,
  target text not null check (target ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}/32$'),
  linked_at timestamptz not null default now(),
  primary key (organization_id, subscriber_id),
  unique (organization_id, router_key, queue_id),
  unique (organization_id, router_key, target),
  foreign key (subscriber_id, organization_id) references public.subscribers(id, organization_id)
);
create index mikrotik_subscriber_queues_subscriber on public.mikrotik_subscriber_queues(subscriber_id);
alter table public.mikrotik_subscriber_queues enable row level security;
revoke all on public.mikrotik_subscriber_queues from public, anon, authenticated;
grant select on public.mikrotik_subscriber_queues to authenticated;
grant select, insert, delete on public.mikrotik_subscriber_queues to service_role;
create policy admin_read_subscriber_queues on public.mikrotik_subscriber_queues
  for select to authenticated using (exists (
    select 1 from public.memberships m where m.user_id=(select auth.uid())
      and m.organization_id=mikrotik_subscriber_queues.organization_id
      and m.role='admin' and m.status='active'));
