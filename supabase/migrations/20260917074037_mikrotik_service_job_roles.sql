-- Remove pending commands created with direct admin speed controls.
-- In-flight commands remain visible for manual reconciliation.
update public.mikrotik_bandwidth_jobs set status='expired', finished_at=now(), result_code='profile_replaced'
  where status='pending';
alter table public.mikrotik_bandwidth_jobs
  add column subscriber_id uuid,
  add column service_id uuid,
  add column required_status text,
  add column required_plan_id uuid;
-- New commands always come from a recorded subscriber service state.
alter table public.mikrotik_bandwidth_jobs add constraint mikrotik_pending_service_only
  check (status <> 'pending' or (subscriber_id is not null and service_id is not null
    and required_plan_id is not null and required_status in ('active','suspended','terminated')));
grant select on public.subscriber_services to service_role;
create index mikrotik_jobs_subscriber on public.mikrotik_bandwidth_jobs(subscriber_id);
create index mikrotik_jobs_service on public.mikrotik_bandwidth_jobs(service_id);
create or replace function public.claim_mikrotik_bandwidth_job(p_org uuid)
returns setof public.mikrotik_bandwidth_jobs language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_org::text));
  update public.mikrotik_bandwidth_jobs set status='expired', finished_at=now()
    where organization_id=p_org and status='pending' and expires_at < now();
  update public.mikrotik_bandwidth_jobs j set status='rejected',result_code='precondition_failed',finished_at=now()
    where j.organization_id=p_org and j.status='pending' and (
      not exists(select 1 from public.memberships m where m.user_id=j.requested_by
        and m.organization_id=p_org and m.role in ('admin','staff') and m.status='active')
      or (j.service_id is not null and not exists(
        select 1 from public.subscriber_services s where s.id=j.service_id and s.organization_id=p_org
          and s.subscriber_id=j.subscriber_id and s.status=j.required_status and s.plan_id=j.required_plan_id))
      or (j.subscriber_id is not null and not exists(
        select 1 from public.mikrotik_subscriber_queues b where b.organization_id=p_org
          and b.subscriber_id=j.subscriber_id and b.queue_id=j.queue_identity->>'id'
          and b.queue_name=j.queue_identity->>'name' and b.target=j.queue_identity->>'target')));
  -- An interrupted write is never delivered twice, even if it was superseded.
  if exists(select 1 from public.mikrotik_bandwidth_jobs where organization_id=p_org and status='running') then return; end if;
  return query update public.mikrotik_bandwidth_jobs set status='running', started_at=now(), lease=gen_random_uuid()
    where id=(select id from public.mikrotik_bandwidth_jobs where organization_id=p_org and status='pending'
      order by created_at,id limit 1 for update skip locked) returning *;
end;
$$;
