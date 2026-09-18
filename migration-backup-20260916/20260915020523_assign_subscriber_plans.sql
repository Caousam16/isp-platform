begin;

grant insert (organization_id, subscriber_id, plan_id, status)
  on public.subscriber_services to authenticated;

create policy service_assign on public.subscriber_services
  for insert
  to authenticated
  with check (
    app_private.has_access(organization_id, array['admin','staff'])
    and status = 'pending'
  );

create unique index subscriber_services_one_current_idx
  on public.subscriber_services (subscriber_id)
  where status <> 'terminated';

create trigger subscriber_services_audit
  after insert on public.subscriber_services
  for each row execute function app_private.audit_insert();

commit;
