create index invoices_subscriber_organization_idx
  on public.invoices (subscriber_id, organization_id);

create index payment_allocations_invoice_scope_idx
  on public.payment_allocations (invoice_id, organization_id, subscriber_id, currency);

create index payment_allocations_payment_scope_idx
  on public.payment_allocations (payment_id, organization_id, subscriber_id, currency);

create index payments_subscriber_organization_idx
  on public.payments (subscriber_id, organization_id);

create index plans_organization_idx
  on public.plans (organization_id);

create index subscriber_services_organization_idx
  on public.subscriber_services (organization_id);

create index subscriber_services_plan_organization_idx
  on public.subscriber_services (plan_id, organization_id);

create index subscriber_services_subscriber_organization_idx
  on public.subscriber_services (subscriber_id, organization_id);

create index subscribers_user_organization_idx
  on public.subscribers (user_id, organization_id)
  where user_id is not null;
