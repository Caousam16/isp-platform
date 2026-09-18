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
