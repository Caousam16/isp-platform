begin;

alter table public.organizations
  add column if not exists address text not null default '',
  add column if not exists tax_id text not null default '',
  add column if not exists contact_email text not null default '',
  add column if not exists contact_phone text not null default '';

alter table public.subscribers
  add column if not exists phone text not null default '';

alter table public.payments
  add column if not exists receipt_number text not null
    default ('OR-LEGACY-' || substr(gen_random_uuid()::text, 1, 8)),
  add column if not exists payment_method text not null default 'Imported';

alter table public.payments
  add constraint payments_organization_receipt_number_key
  unique (organization_id, receipt_number);

create table app_private.document_sequences (
  organization_id uuid not null references public.organizations(id),
  document_kind text not null check (document_kind in ('invoice', 'receipt')),
  document_year integer not null check (document_year between 2000 and 9999),
  last_value bigint not null default 0 check (last_value >= 0),
  primary key (organization_id, document_kind, document_year)
);
revoke all on app_private.document_sequences from public, anon, authenticated;

grant update (email, phone, address) on public.subscribers to authenticated;
grant insert (phone) on public.subscribers to authenticated;
create policy subscriber_update_own_contact
  on public.subscribers for update to authenticated
  using (app_private.owns_subscriber(id, organization_id))
  with check (app_private.owns_subscriber(id, organization_id));

create or replace function app_private.next_document_number(
  p_organization_id uuid,
  p_kind text,
  p_date date
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  sequence_value bigint;
  prefix text;
  v_document_year integer := extract(year from p_date)::integer;
begin
  if p_kind not in ('invoice', 'receipt') then
    raise exception 'Unsupported document kind' using errcode = '22023';
  end if;

  insert into app_private.document_sequences(
    organization_id, document_kind, document_year, last_value
  ) values (p_organization_id, p_kind, v_document_year, 1)
  on conflict (organization_id, document_kind, document_year)
  do update set last_value = app_private.document_sequences.last_value + 1
  returning last_value into sequence_value;

  prefix := case when p_kind = 'invoice' then 'INV' else 'OR' end;
  return prefix || '-' || v_document_year::text || '-' || lpad(sequence_value::text, 6, '0');
end;
$function$;
revoke all on function app_private.next_document_number(uuid, text, date)
  from public, anon, authenticated;

create or replace function app_private.create_invoice(
  p_subscriber_id uuid,
  p_issued_on date,
  p_due_on date,
  p_description text,
  p_total_minor bigint
)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $function$
declare
  subscriber_row public.subscribers;
  organization_row public.organizations;
  invoice_row public.invoices;
  invoice_number text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;
  if p_due_on < p_issued_on then
    raise exception 'Due date cannot be before issue date' using errcode = '22023';
  end if;
  if length(trim(p_description)) not between 2 and 500 then
    raise exception 'Invoice description must be between 2 and 500 characters' using errcode = '22023';
  end if;
  if p_total_minor <= 0 or p_total_minor > 9999999999 then
    raise exception 'Invoice total is invalid' using errcode = '22023';
  end if;

  select * into subscriber_row from public.subscribers
  where id = p_subscriber_id;
  if not found then
    raise exception 'Subscriber not found' using errcode = 'P0002';
  end if;
  if not app_private.has_access(subscriber_row.organization_id, array['admin'::text, 'staff'::text]) then
    raise exception 'You do not have permission to create this invoice' using errcode = '42501';
  end if;

  select * into organization_row from public.organizations
  where id = subscriber_row.organization_id;
  invoice_number := app_private.next_document_number(
    subscriber_row.organization_id, 'invoice', p_issued_on
  );

  insert into public.invoices(
    organization_id, subscriber_id, number, issued_on, due_on,
    description, total_minor, currency
  ) values (
    subscriber_row.organization_id, subscriber_row.id, invoice_number,
    p_issued_on, p_due_on, trim(p_description), p_total_minor,
    organization_row.currency
  ) returning * into invoice_row;

  insert into public.audit_events(
    organization_id, actor_id, action, entity_type, entity_id, metadata
  ) values (
    invoice_row.organization_id, (select auth.uid()), 'invoice.created',
    'invoice', invoice_row.id,
    jsonb_build_object('number', invoice_row.number, 'total_minor', invoice_row.total_minor)
  );
  return invoice_row;
end;
$function$;
revoke all on function app_private.create_invoice(uuid, date, date, text, bigint)
  from public, anon;
grant execute on function app_private.create_invoice(uuid, date, date, text, bigint)
  to authenticated;

create or replace function public.create_invoice(
  p_subscriber_id uuid,
  p_issued_on date,
  p_due_on date,
  p_description text,
  p_total_minor bigint
)
returns public.invoices
language sql
security invoker
set search_path = ''
as $function$
  select app_private.create_invoice(
    p_subscriber_id, p_issued_on, p_due_on, p_description, p_total_minor
  );
$function$;
revoke all on function public.create_invoice(uuid, date, date, text, bigint)
  from public, anon;
grant execute on function public.create_invoice(uuid, date, date, text, bigint)
  to authenticated;

create or replace function app_private.post_invoice_payment(
  p_invoice_id uuid,
  p_amount_minor bigint,
  p_payment_method text,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  invoice_row public.invoices;
  payment_row public.payments;
  allocation_row public.payment_allocations;
  paid_total bigint;
  receipt_number text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;
  if p_amount_minor <= 0 then
    raise exception 'Payment amount must be positive' using errcode = '22023';
  end if;
  if length(trim(p_payment_method)) not between 2 and 60 then
    raise exception 'Payment method is invalid' using errcode = '22023';
  end if;
  if length(trim(p_reference)) not between 2 and 100 then
    raise exception 'Payment reference is invalid' using errcode = '22023';
  end if;

  select * into invoice_row from public.invoices
  where id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if not app_private.has_access(invoice_row.organization_id, array['admin'::text, 'staff'::text]) then
    raise exception 'You do not have permission to post this payment' using errcode = '42501';
  end if;
  select coalesce(sum(amount_minor), 0) into paid_total
  from public.payment_allocations where invoice_id = invoice_row.id;
  if paid_total + p_amount_minor > invoice_row.total_minor then
    raise exception 'Payment exceeds the invoice balance' using errcode = '22023';
  end if;

  receipt_number := app_private.next_document_number(
    invoice_row.organization_id, 'receipt', current_date
  );
  insert into public.payments(
    organization_id, subscriber_id, reference, receipt_number,
    payment_method, amount_minor, currency
  ) values (
    invoice_row.organization_id, invoice_row.subscriber_id, trim(p_reference),
    receipt_number, trim(p_payment_method), p_amount_minor, invoice_row.currency
  ) returning * into payment_row;

  insert into public.payment_allocations(
    organization_id, subscriber_id, currency, invoice_id, payment_id, amount_minor
  ) values (
    invoice_row.organization_id, invoice_row.subscriber_id, invoice_row.currency,
    invoice_row.id, payment_row.id, p_amount_minor
  ) returning * into allocation_row;

  insert into public.audit_events(
    organization_id, actor_id, action, entity_type, entity_id, metadata
  ) values (
    invoice_row.organization_id, (select auth.uid()), 'payment.posted',
    'payment', payment_row.id,
    jsonb_build_object('receipt_number', payment_row.receipt_number,
      'invoice_id', invoice_row.id, 'amount_minor', payment_row.amount_minor)
  );

  return jsonb_build_object('payment', to_jsonb(payment_row),
    'allocation', to_jsonb(allocation_row));
end;
$function$;
revoke all on function app_private.post_invoice_payment(uuid, bigint, text, text)
  from public, anon;
grant execute on function app_private.post_invoice_payment(uuid, bigint, text, text)
  to authenticated;

create or replace function public.post_invoice_payment(
  p_invoice_id uuid,
  p_amount_minor bigint,
  p_payment_method text,
  p_reference text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select app_private.post_invoice_payment(
    p_invoice_id, p_amount_minor, p_payment_method, p_reference
  );
$function$;
revoke all on function public.post_invoice_payment(uuid, bigint, text, text)
  from public, anon;
grant execute on function public.post_invoice_payment(uuid, bigint, text, text)
  to authenticated;

drop view if exists public.invoice_balances;
create view public.invoice_balances with (security_invoker = true) as
select i.id, i.organization_id, i.subscriber_id, i.number, i.issued_on,
  i.due_on, i.description, i.total_minor, i.currency,
  coalesce((select sum(a.amount_minor) from public.payment_allocations a
    where a.invoice_id = i.id), 0)::bigint as paid_minor
from public.invoices i;
revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to authenticated;

create index if not exists subscriber_services_status_idx
  on public.subscriber_services (organization_id, status);
create index if not exists payments_received_at_idx
  on public.payments (organization_id, received_at desc);

commit;
