create table public.mikrotik_bandwidth_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  router_key text not null default 'local-test' check (router_key = 'local-test'),
  requested_by uuid not null references auth.users(id),
  queue_identity jsonb not null check (jsonb_typeof(queue_identity) = 'object'),
  expected jsonb not null check (jsonb_typeof(expected) = 'object'),
  desired jsonb not null check (jsonb_typeof(desired) = 'object'),
  status text not null default 'pending' check (status in ('pending','running','applied','rejected','uncertain','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  started_at timestamptz,
  finished_at timestamptz,
  lease uuid,
  result_code text,
  restore_of uuid references public.mikrotik_bandwidth_jobs(id)
);
create index mikrotik_jobs_org_time on public.mikrotik_bandwidth_jobs(organization_id, created_at);
create index mikrotik_jobs_requester on public.mikrotik_bandwidth_jobs(requested_by);
create index mikrotik_jobs_restore on public.mikrotik_bandwidth_jobs(restore_of);
create unique index mikrotik_one_active_queue on public.mikrotik_bandwidth_jobs
  (organization_id, router_key, (queue_identity->>'id')) where status in ('pending','running','uncertain');
alter table public.mikrotik_bandwidth_jobs enable row level security;
revoke all on public.mikrotik_bandwidth_jobs from public, anon, authenticated;
grant select on public.mikrotik_bandwidth_jobs to authenticated;
grant select,insert,update on public.mikrotik_bandwidth_jobs to service_role;
create policy admin_read_bandwidth_jobs on public.mikrotik_bandwidth_jobs for select to authenticated using (
  exists (select 1 from public.memberships m where m.user_id=(select auth.uid())
    and m.organization_id=mikrotik_bandwidth_jobs.organization_id and m.role='admin' and m.status='active')
);
-- Service-only, security invoker: never grant this function to browser roles.
create function public.claim_mikrotik_bandwidth_job(p_org uuid)
returns setof public.mikrotik_bandwidth_jobs language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_org::text));
  update public.mikrotik_bandwidth_jobs set status='expired',finished_at=now()
    where organization_id=p_org and status='pending' and expires_at < now();
  update public.mikrotik_bandwidth_jobs j set status='rejected',result_code='precondition_failed',finished_at=now()
    where j.organization_id=p_org and j.status='pending' and not exists (
      select 1 from public.memberships m where m.user_id=j.requested_by and m.organization_id=p_org
        and m.role='admin' and m.status='active');
  -- Never automatically re-deliver a running command: a lost response may mean it already ran.
  if exists(select 1 from public.mikrotik_bandwidth_jobs where organization_id=p_org and status='running') then return; end if;
  return query update public.mikrotik_bandwidth_jobs set status='running', started_at=now(), lease=gen_random_uuid()
    where id=(select id from public.mikrotik_bandwidth_jobs where organization_id=p_org and status='pending'
      order by created_at,id limit 1 for update skip locked) returning *;
end;
$$;
revoke all on function public.claim_mikrotik_bandwidth_job(uuid) from public,anon,authenticated;
grant execute on function public.claim_mikrotik_bandwidth_job(uuid) to service_role;
