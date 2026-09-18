begin;

alter table public.audit_events
  add column metadata jsonb not null default '{}'::jsonb;

create or replace function public.manage_subscriber_service(
  p_service_id uuid,
  p_action text,
  p_plan_id uuid default null
)
returns public.subscriber_services
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service public.subscriber_services;
  v_plan public.plans;
  v_previous_status text;
  v_previous_plan_id uuid;
  v_next_status text;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='28000'; end if;
  if p_action not in ('activate','suspend','reconnect','terminate','change_plan') then raise exception 'Unsupported service action: %',p_action using errcode='22023'; end if;
  select * into v_service from public.subscriber_services where id=p_service_id for update;
  if not found then raise exception 'Service not found' using errcode='P0002'; end if;
  if not app_private.has_access(v_service.organization_id,array['admin'::text,'staff'::text]) then raise exception 'You do not have permission to manage this service' using errcode='42501'; end if;
  v_previous_status:=v_service.status; v_previous_plan_id:=v_service.plan_id; v_next_status:=v_previous_status;
  case p_action
    when 'activate' then if v_previous_status <> 'pending' then raise exception 'Only pending services can be activated' using errcode='22023'; end if; v_next_status:='active';
    when 'suspend' then if v_previous_status <> 'active' then raise exception 'Only active services can be suspended' using errcode='22023'; end if; v_next_status:='suspended';
    when 'reconnect' then if v_previous_status <> 'suspended' then raise exception 'Only suspended services can be reconnected' using errcode='22023'; end if; v_next_status:='active';
    when 'terminate' then if v_previous_status='terminated' then raise exception 'Service is already terminated' using errcode='22023'; end if; v_next_status:='terminated';
    when 'change_plan' then
      if v_previous_status='terminated' then raise exception 'A terminated service cannot change plans' using errcode='22023'; end if;
      if p_plan_id is null then raise exception 'A plan is required to change plans' using errcode='22023'; end if;
      select * into v_plan from public.plans where id=p_plan_id and organization_id=v_service.organization_id;
      if not found then raise exception 'Plan not found for this organization' using errcode='22023'; end if;
      if v_plan.id=v_service.plan_id then raise exception 'Service is already on this plan' using errcode='22023'; end if;
  end case;
  update public.subscriber_services set status=v_next_status,plan_id=case when p_action='change_plan' then v_plan.id else plan_id end,updated_at=now() where id=v_service.id returning * into v_service;
  insert into public.audit_events(organization_id,actor_id,action,entity_type,entity_id,metadata)
  values(v_service.organization_id,auth.uid(),'subscriber_service.'||p_action,'subscriber_service',v_service.id,jsonb_build_object('previous_status',v_previous_status,'status',v_service.status,'previous_plan_id',v_previous_plan_id,'plan_id',v_service.plan_id));
  return v_service;
end;
$$;

commit;
