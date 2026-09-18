begin;

alter table public.subscriber_services
  add column activated_at timestamptz,
  add column suspended_at timestamptz,
  add column terminated_at timestamptz,
  add column status_reason text check (status_reason is null or length(status_reason) between 2 and 500),
  add column updated_at timestamptz not null default now();

update public.subscriber_services
set activated_at = case when status in ('active','suspended','terminated') then created_at end,
    suspended_at = case when status = 'suspended' then created_at end,
    terminated_at = case when status = 'terminated' then created_at end;

grant update (plan_id, status, activated_at, suspended_at, terminated_at, status_reason, updated_at)
  on public.subscriber_services to authenticated;

create policy service_update on public.subscriber_services
  for update
  to authenticated
  using (app_private.has_access(organization_id, array['admin','staff']))
  with check (app_private.has_access(organization_id, array['admin','staff']));

create or replace function app_private.enforce_service_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not app_private.has_access(old.organization_id, array['admin','staff']) then
    raise exception 'Service lifecycle changes require active staff or administrator access';
  end if;

  if old.status = 'terminated' then
    raise exception 'Terminated services are immutable';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'pending' and new.status in ('active','terminated')) or
      (old.status = 'active' and new.status in ('suspended','terminated')) or
      (old.status = 'suspended' and new.status in ('active','terminated'))
    ) then
      raise exception 'Invalid service status transition from % to %', old.status, new.status;
    end if;
  end if;

  if new.plan_id <> old.plan_id and new.status = 'terminated' then
    raise exception 'Cannot change the plan on a terminated service';
  end if;

  if (new.status in ('suspended','terminated') and new.status <> old.status)
     or new.plan_id <> old.plan_id then
    if nullif(btrim(new.status_reason), '') is null then
      raise exception 'A reason is required for suspension, termination, or plan change';
    end if;
  end if;

  new.status_reason := nullif(btrim(new.status_reason), '');
  new.activated_at := old.activated_at;
  new.suspended_at := old.suspended_at;
  new.terminated_at := old.terminated_at;

  if new.status <> old.status then
    if new.status = 'active' then
      new.activated_at := coalesce(old.activated_at, now());
      new.suspended_at := null;
    elsif new.status = 'suspended' then
      new.suspended_at := now();
    elsif new.status = 'terminated' then
      new.terminated_at := now();
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke all on function app_private.enforce_service_lifecycle() from public;

create trigger subscriber_services_lifecycle
  before update on public.subscriber_services
  for each row execute function app_private.enforce_service_lifecycle();

create or replace function app_private.audit_service_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare event_action text;
begin
  if new.status <> old.status then
    event_action := 'subscriber_services.' || new.status;
  elsif new.plan_id <> old.plan_id then
    event_action := 'subscriber_services.plan_changed';
  else
    event_action := 'subscriber_services.updated';
  end if;

  insert into public.audit_events(organization_id, actor_id, action, entity_type, entity_id)
  values (new.organization_id, auth.uid(), event_action, 'subscriber_services', new.id);
  return new;
end;
$$;
revoke all on function app_private.audit_service_change() from public;

create trigger subscriber_services_change_audit
  after update on public.subscriber_services
  for each row execute function app_private.audit_service_change();

commit;
