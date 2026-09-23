begin;
drop trigger if exists subscriber_services_lifecycle on public.subscriber_services;
drop trigger if exists subscriber_services_change_audit on public.subscriber_services;
drop policy if exists service_update on public.subscriber_services;
revoke update on public.subscriber_services from authenticated;
revoke update(plan_id,status,updated_at) on public.subscriber_services from authenticated;
do $$ declare c text; begin
for c in select column_name from information_schema.columns where table_schema='public' and table_name='subscriber_services' and column_name in ('activated_at','suspended_at','terminated_at','status_reason') loop
execute format('revoke update(%I) on public.subscriber_services from authenticated',c); end loop;end;$$;
grant usage on schema public,app_private to service_role;
grant select on public.organizations,public.memberships,public.subscribers,public.plans,public.subscriber_services,public.invoices,public.payments,public.payment_allocations,public.invoice_balances,public.audit_events to service_role;
grant insert,delete on public.memberships to service_role;
grant insert on public.subscribers,public.plans,public.audit_events to service_role;
grant update(user_id) on public.subscribers to service_role;
alter table public.audit_events
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.subscriber_services
  add column if not exists updated_at timestamptz not null default now();

create or replace function app_private.manage_subscriber_service(
  p_service_id uuid,
  p_action text,
  p_plan_id uuid default null
)
returns public.subscriber_services
language plpgsql
security definer
set search_path = ''
as $function$
declare
  service_row public.subscriber_services;
  requested_plan public.plans;
  previous_status text;
  previous_plan_id uuid;
  next_status text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;

  if p_action not in ('activate', 'suspend', 'reconnect', 'terminate', 'change_plan') then
    raise exception 'Unsupported service action: %', p_action using errcode = '22023';
  end if;

  select * into service_row
  from public.subscriber_services
  where id = p_service_id
  for update;

  if not found then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;

  if not app_private.has_access(
    service_row.organization_id,
    array['admin'::text, 'staff'::text]
  ) then
    raise exception 'You do not have permission to manage this service'
      using errcode = '42501';
  end if;

  if p_action <> 'suspend' and not app_private.has_access(service_row.organization_id,array['admin']) then
    raise exception 'Only administrators can activate, reconnect, terminate, or change plans' using errcode='42501';
  end if;
  previous_status := service_row.status;
  previous_plan_id := service_row.plan_id;
  next_status := previous_status;

  case p_action
    when 'activate' then
      if previous_status <> 'pending' then
        raise exception 'Only pending services can be activated' using errcode = '22023';
      end if;
      next_status := 'active';
    when 'suspend' then
      if previous_status <> 'active' then
        raise exception 'Only active services can be suspended' using errcode = '22023';
      end if;
      next_status := 'suspended';
    when 'reconnect' then
      if previous_status <> 'suspended' then
        raise exception 'Only suspended services can be reconnected' using errcode = '22023';
      end if;
      next_status := 'active';
    when 'terminate' then
      if previous_status = 'terminated' then
        raise exception 'Service is already terminated' using errcode = '22023';
      end if;
      next_status := 'terminated';
    when 'change_plan' then
      if previous_status = 'terminated' then
        raise exception 'A terminated service cannot change plans' using errcode = '22023';
      end if;
      if p_plan_id is null then
        raise exception 'A plan is required to change plans' using errcode = '22023';
      end if;

      select * into requested_plan
      from public.plans
      where id = p_plan_id
        and organization_id = service_row.organization_id;

      if not found then
        raise exception 'Plan not found for this organization' using errcode = '22023';
      end if;
      if requested_plan.id = service_row.plan_id then
        raise exception 'Service is already on this plan' using errcode = '22023';
      end if;
  end case;

  update public.subscriber_services
  set status = next_status,
      plan_id = case
        when p_action = 'change_plan' then requested_plan.id
        else plan_id
      end,
      updated_at = now()
  where id = service_row.id
  returning * into service_row;

  insert into public.audit_events(
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    service_row.organization_id,
    (select auth.uid()),
    'subscriber_service.' || p_action,
    'subscriber_service',
    service_row.id,
    jsonb_build_object(
      'previous_status', previous_status,
      'status', service_row.status,
      'previous_plan_id', previous_plan_id,
      'plan_id', service_row.plan_id
    )
  );

  return service_row;
end;
$function$;

revoke all on function app_private.manage_subscriber_service(uuid, text, uuid)
  from public, anon;
grant execute on function app_private.manage_subscriber_service(uuid, text, uuid)
  to authenticated;

create or replace function public.manage_subscriber_service(
  p_service_id uuid,
  p_action text,
  p_plan_id uuid default null
)
returns public.subscriber_services
language sql
security invoker
set search_path = ''
as $function$
  select app_private.manage_subscriber_service(p_service_id, p_action, p_plan_id);
$function$;

revoke all on function public.manage_subscriber_service(uuid, text, uuid)
  from public, anon;
grant execute on function public.manage_subscriber_service(uuid, text, uuid)
  to authenticated;
;
alter table public.mikrotik_snapshots drop constraint if exists mikrotik_snapshots_router_key_check;
alter table public.mikrotik_snapshots add constraint mikrotik_snapshots_router_key_check check(router_key ~ '^[a-z0-9][a-z0-9-]{0,63}$');
alter table public.mikrotik_bandwidth_jobs drop constraint if exists mikrotik_bandwidth_jobs_router_key_check;
alter table public.mikrotik_bandwidth_jobs add constraint mikrotik_bandwidth_jobs_router_key_check check(router_key ~ '^[a-z0-9][a-z0-9-]{0,63}$');
alter table public.mikrotik_subscriber_queues drop constraint if exists mikrotik_subscriber_queues_router_key_check;
alter table public.mikrotik_subscriber_queues add constraint mikrotik_subscriber_queues_router_key_check check(router_key ~ '^[a-z0-9][a-z0-9-]{0,63}$');
alter table public.mikrotik_snapshots add column collected_at timestamptz;
do $$ declare c record; begin
for c in select conname from pg_constraint where conrelid='public.mikrotik_subscriber_queues'::regclass and contype='u' and (pg_get_constraintdef(oid) like '%router_key, queue_id%' or pg_get_constraintdef(oid) like '%router_key, target%') loop
execute format('alter table public.mikrotik_subscriber_queues drop constraint %I',c.conname);end loop;end;$$;
alter table public.mikrotik_subscriber_queues add constraint mikrotik_mapping_queue_unique unique(organization_id,router_key,queue_id) deferrable initially deferred;
alter table public.mikrotik_subscriber_queues add constraint mikrotik_mapping_target_unique unique(organization_id,router_key,target) deferrable initially deferred;
drop policy admin_read_router_snapshot on public.mikrotik_snapshots;
create policy admin_read_router_snapshot on public.mikrotik_snapshots for select to authenticated using(app_private.has_access(organization_id,array['admin']));
drop policy admin_read_bandwidth_jobs on public.mikrotik_bandwidth_jobs;
create policy admin_read_bandwidth_jobs on public.mikrotik_bandwidth_jobs for select to authenticated using(app_private.has_access(organization_id,array['admin']));
drop policy admin_read_subscriber_queues on public.mikrotik_subscriber_queues;
create policy admin_read_subscriber_queues on public.mikrotik_subscriber_queues for select to authenticated using(app_private.has_access(organization_id,array['admin']));

create function public.ingest_mikrotik_snapshot(p_org uuid,p_router text,p_snapshot jsonb,p_collected_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
if p_collected_at is null or p_collected_at < now()-interval '10 minutes' or p_collected_at > now()+interval '1 minute' then raise exception 'Invalid snapshot time';end if;
perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text||':'||p_router,0));
if exists(select 1 from public.mikrotik_snapshots where organization_id=p_org and router_key=p_router and collected_at>=p_collected_at) then return;end if;
insert into public.mikrotik_snapshots(organization_id,router_key,received_at,collected_at,snapshot) values(p_org,p_router,now(),p_collected_at,p_snapshot)
on conflict(organization_id,router_key) do update set received_at=now(),collected_at=excluded.collected_at,snapshot=excluded.snapshot;
with leases as (
select l as lease_json,count(*) over(partition by upper(l->>'macAddress')) mac_count,count(*) over(partition by l->>'address') ip_count from jsonb_array_elements(p_snapshot->'dhcpLeases') l
), queues as (
select q as queue_json,count(*) over(partition by q->>'target') target_count from jsonb_array_elements(p_snapshot->'queues') q where q->>'kind'='simple' and q->>'dynamic'='false' and q->>'disabled'='false' and q->>'parent'='none' and q->>'packetMarks'='' and q ? 'settings'
), observed as (
select b.subscriber_id,l.lease_json lease,q.queue_json queue from public.mikrotik_subscriber_queues b
left join leases l on upper(l.lease_json->>'macAddress')=b.mac_address and l.mac_count=1 and l.ip_count=1
left join queues q on q.queue_json->>'target'=(l.lease_json->>'address')||'/32' and q.target_count=1
where b.organization_id=p_org and b.router_key=p_router
)
update public.mikrotik_subscriber_queues b set ip_address=coalesce((o.lease->>'address')::inet,b.ip_address),dhcp_lease_id=o.lease->>'id',dhcp_host_name=nullif(o.lease->>'hostName',''),dhcp_status=coalesce(o.lease->>'status','unknown'),queue_id=o.queue->>'id',queue_name=o.queue->>'name',target=o.queue->>'target',network_seen_at=case when o.lease is not null then now() else b.network_seen_at end
from observed o where b.organization_id=p_org and b.router_key=p_router and b.subscriber_id=o.subscriber_id
and (b.ip_address,b.dhcp_lease_id,b.dhcp_host_name,b.dhcp_status,b.queue_id,b.queue_name,b.target) is distinct from
(coalesce((o.lease->>'address')::inet,b.ip_address),o.lease->>'id',nullif(o.lease->>'hostName',''),coalesce(o.lease->>'status','unknown'),o.queue->>'id',o.queue->>'name',o.queue->>'target');
end;$$;
revoke all on function public.ingest_mikrotik_snapshot(uuid,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ingest_mikrotik_snapshot(uuid,text,jsonb,timestamptz) to service_role;

create function app_private.enqueue_service_router(p_service uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.subscriber_services;b public.mikrotik_subscriber_queues; snap public.mikrotik_snapshots;p public.plans;q jsonb;desired jsonb;rates text;burst text;
begin
select * into s from public.subscriber_services where id=p_service for update;
if not found or auth.uid() is null or not app_private.has_access(s.organization_id,array['admin','staff']) then raise exception 'Access denied' using errcode='42501';end if;
if s.status<>'suspended' and not app_private.has_access(s.organization_id,array['admin']) then raise exception 'Only administrators can perform this router action' using errcode='42501';end if;
if s.status='pending' then return false;end if;
select * into b from public.mikrotik_subscriber_queues where organization_id=s.organization_id and subscriber_id=s.subscriber_id;
if not found then return false;end if;
perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(b.organization_id::text||':'||b.router_key,0));
select * into b from public.mikrotik_subscriber_queues where organization_id=s.organization_id and subscriber_id=s.subscriber_id;
if not found then return false;end if;
if b.queue_id is null then raise exception 'Mapped ONU has no eligible queue; refresh and verify its DHCP identity';end if;
select * into snap from public.mikrotik_snapshots where organization_id=b.organization_id and router_key=b.router_key;
if not found or coalesce(snap.collected_at,snap.received_at)<now()-interval '6 minutes' then raise exception 'Router snapshot is stale; refresh before changing this service';end if;
select value into q from jsonb_array_elements(snap.snapshot->'queues') where value->>'id'=b.queue_id and value->>'name'=b.queue_name and value->>'target'=b.target and value->>'kind'='simple' and value->>'dynamic'='false' and value->>'disabled'='false' and value->>'parent'='none' and value->>'packetMarks'='' and value ? 'settings';
if q is null then raise exception 'Router queue changed; refresh before changing this service';end if;
if exists(select 1 from public.mikrotik_bandwidth_jobs where organization_id=b.organization_id and router_key=b.router_key and queue_identity->>'id'=b.queue_id and status in ('running','uncertain')) then raise exception 'A router command needs completion or reconciliation before another change';end if;
select * into p from public.plans where id=s.plan_id and organization_id=s.organization_id;
if s.status='active' then rates:=(p.upload_mbps::bigint*1000000)::text||'/'||(p.download_mbps::bigint*1000000)::text;burst:=((p.upload_mbps::bigint+10)*1000000)::text||'/'||((p.download_mbps::bigint+10)*1000000)::text;
else rates:='1000/1000';burst:='1000/1000';end if;
desired:=jsonb_build_object('maxLimit',rates,'limitAt',rates,'burstLimit',burst,'burstThreshold',burst,'burstTime','8s/8s');
update public.mikrotik_bandwidth_jobs set status='expired',finished_at=now(),result_code='profile_replaced' where organization_id=b.organization_id and router_key=b.router_key and queue_identity->>'id'=b.queue_id and status='pending';
insert into public.mikrotik_bandwidth_jobs(organization_id,router_key,requested_by,subscriber_id,service_id,required_status,required_plan_id,queue_identity,expected,desired)
values(s.organization_id,b.router_key,auth.uid(),s.subscriber_id,s.id,s.status,s.plan_id,jsonb_build_object('id',b.queue_id,'name',b.queue_name,'target',b.target),q->'settings',desired);
return true;
end;$$;
revoke all on function app_private.enqueue_service_router(uuid) from public,anon,authenticated;
create function app_private.enqueue_service_change() returns trigger language plpgsql security definer set search_path='' as $$ begin
if (old.status,old.plan_id) is distinct from (new.status,new.plan_id) then perform app_private.enqueue_service_router(new.id);end if;return new;end;$$;
revoke all on function app_private.enqueue_service_change() from public,anon,authenticated;
create trigger service_router_intent after update of status,plan_id on public.subscriber_services for each row execute function app_private.enqueue_service_change();
create function app_private.sync_subscriber_router(p_subscriber uuid) returns boolean language plpgsql security definer set search_path='' as $$ declare s public.subscriber_services;begin
select * into s from public.subscriber_services where subscriber_id=p_subscriber order by (status<>'terminated') desc,created_at desc,id desc limit 1;
if not found or not app_private.has_access(s.organization_id,array['admin']) then raise exception 'Access denied' using errcode='42501';end if;
return app_private.enqueue_service_router(s.id);end;$$;
revoke all on function app_private.sync_subscriber_router(uuid) from public,anon;
grant execute on function app_private.sync_subscriber_router(uuid) to authenticated;
create function public.sync_subscriber_router(p_subscriber uuid) returns boolean language sql security invoker set search_path='' as $$ select app_private.sync_subscriber_router(p_subscriber);$$;
revoke all on function public.sync_subscriber_router(uuid) from public,anon;
grant execute on function public.sync_subscriber_router(uuid) to authenticated;

drop function public.claim_mikrotik_bandwidth_job(uuid);
create function public.claim_mikrotik_bandwidth_job(p_org uuid,p_router text) returns setof public.mikrotik_bandwidth_jobs language plpgsql security invoker set search_path='' as $$ begin
perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text||':'||p_router,0));
update public.mikrotik_bandwidth_jobs set status='uncertain',result_code='interrupted',finished_at=now() where organization_id=p_org and router_key=p_router and status='running' and started_at<now()-interval '5 minutes';
update public.mikrotik_bandwidth_jobs set status='expired',finished_at=now() where organization_id=p_org and router_key=p_router and status='pending' and expires_at<now();
update public.mikrotik_bandwidth_jobs j set status='rejected',result_code='precondition_failed',finished_at=now() where j.organization_id=p_org and j.router_key=p_router and j.status='pending' and (
not exists(select 1 from public.memberships m where m.user_id=j.requested_by and m.status='active' and (m.role='admin' or (m.organization_id=p_org and m.role='staff' and j.required_status='suspended')))
or not exists(select 1 from public.subscriber_services s where s.id=j.service_id and s.organization_id=p_org and s.subscriber_id=j.subscriber_id and s.status=j.required_status and s.plan_id=j.required_plan_id)
or not exists(select 1 from public.mikrotik_subscriber_queues b where b.organization_id=p_org and b.router_key=p_router and b.subscriber_id=j.subscriber_id and b.queue_id=j.queue_identity->>'id' and b.queue_name=j.queue_identity->>'name' and b.target=j.queue_identity->>'target'));
if exists(select 1 from public.mikrotik_bandwidth_jobs where organization_id=p_org and router_key=p_router and status='running') then return;end if;
return query update public.mikrotik_bandwidth_jobs set status='running',started_at=now(),lease=gen_random_uuid() where id=(select id from public.mikrotik_bandwidth_jobs where organization_id=p_org and router_key=p_router and status='pending' order by created_at,id limit 1 for update skip locked) returning *;
end;$$;
revoke all on function public.claim_mikrotik_bandwidth_job(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_mikrotik_bandwidth_job(uuid,text) to service_role;
create index mikrotik_jobs_router_status_time on public.mikrotik_bandwidth_jobs(organization_id,router_key,status,created_at);

create function app_private.unlink_subscriber_router(p_subscriber uuid) returns void language plpgsql security definer set search_path='' as $$ declare b public.mikrotik_subscriber_queues;begin
select * into b from public.mikrotik_subscriber_queues where subscriber_id=p_subscriber;
if not found or not app_private.has_access(b.organization_id,array['admin']) then raise exception 'Access denied' using errcode='42501';end if;
perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(b.organization_id::text||':'||b.router_key,0));
if exists(select 1 from public.mikrotik_bandwidth_jobs where subscriber_id=p_subscriber and status in ('running','uncertain')) then raise exception 'Reconcile outstanding router commands before unlinking';end if;
update public.mikrotik_bandwidth_jobs set status='expired',finished_at=now(),result_code='mapping_removed' where subscriber_id=p_subscriber and status='pending';
delete from public.mikrotik_subscriber_queues where organization_id=b.organization_id and subscriber_id=p_subscriber;
insert into public.audit_events(organization_id,actor_id,action,entity_type,entity_id) values(b.organization_id,auth.uid(),'subscriber.router.unlinked','subscriber',p_subscriber);
end;$$;
revoke all on function app_private.unlink_subscriber_router(uuid) from public,anon;
grant execute on function app_private.unlink_subscriber_router(uuid) to authenticated;
create function public.unlink_subscriber_router(p_subscriber uuid) returns void language sql security invoker set search_path='' as $$select app_private.unlink_subscriber_router(p_subscriber);$$;
revoke all on function public.unlink_subscriber_router(uuid) from public,anon;
grant execute on function public.unlink_subscriber_router(uuid) to authenticated;

create table app_private.billing_requests(request_id uuid primary key,actor_id uuid not null references auth.users(id),kind text not null,payload jsonb not null,result jsonb not null,created_at timestamptz not null default now());
alter table app_private.billing_requests enable row level security;
revoke all on app_private.billing_requests from public,anon,authenticated,service_role;
revoke execute on function public.create_invoice(uuid,date,date,text,bigint),app_private.create_invoice(uuid,date,date,text,bigint),public.post_invoice_payment(uuid,bigint,text,text),app_private.post_invoice_payment(uuid,bigint,text,text) from authenticated;
create function app_private.billing_request(p_request uuid,p_kind text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;prior app_private.billing_requests;result jsonb;begin
if auth.uid() is null or p_request is null then raise exception 'Authentication and request ID required' using errcode='28000';end if;
if p_kind='invoice' then select organization_id into org from public.subscribers where id=(p_payload->>'subscriber_id')::uuid;
elsif p_kind='payment' then select organization_id into org from public.invoices where id=(p_payload->>'invoice_id')::uuid;
else raise exception 'Invalid billing operation';end if;
if org is null or not app_private.has_access(org,array['admin','staff']) then raise exception 'Access denied' using errcode='42501';end if;
perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,1));
select * into prior from app_private.billing_requests where request_id=p_request;
if found then
if prior.actor_id<>auth.uid() or prior.kind<>p_kind or prior.payload<>p_payload then raise exception 'Request ID already used for different input' using errcode='22023';end if;
return prior.result;end if;
if p_kind='invoice' then select to_jsonb(i) into result from app_private.create_invoice((p_payload->>'subscriber_id')::uuid,(p_payload->>'issued_on')::date,(p_payload->>'due_on')::date,p_payload->>'description',(p_payload->>'total_minor')::bigint) i;
else result:=app_private.post_invoice_payment((p_payload->>'invoice_id')::uuid,(p_payload->>'amount_minor')::bigint,p_payload->>'payment_method',p_payload->>'reference');end if;
insert into app_private.billing_requests(request_id,actor_id,kind,payload,result) values(p_request,auth.uid(),p_kind,p_payload,result);return result;end;$$;
revoke all on function app_private.billing_request(uuid,text,jsonb) from public,anon;
grant execute on function app_private.billing_request(uuid,text,jsonb) to authenticated;
create function public.create_invoice(p_subscriber_id uuid,p_issued_on date,p_due_on date,p_description text,p_total_minor bigint,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select app_private.billing_request(p_request_id,'invoice',jsonb_build_object('subscriber_id',p_subscriber_id,'issued_on',p_issued_on,'due_on',p_due_on,'description',p_description,'total_minor',p_total_minor));$$;
create function public.post_invoice_payment(p_invoice_id uuid,p_amount_minor bigint,p_payment_method text,p_reference text,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select app_private.billing_request(p_request_id,'payment',jsonb_build_object('invoice_id',p_invoice_id,'amount_minor',p_amount_minor,'payment_method',p_payment_method,'reference',p_reference));$$;
revoke all on function public.create_invoice(uuid,date,date,text,bigint,uuid),public.post_invoice_payment(uuid,bigint,text,text,uuid) from public,anon;
grant execute on function public.create_invoice(uuid,date,date,text,bigint,uuid),public.post_invoice_payment(uuid,bigint,text,text,uuid) to authenticated;
commit;
