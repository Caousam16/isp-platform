-- Apply to an empty Supabase project. No real customer fixtures or credentials.
begin;
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null,
  currency text not null default 'PHP' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Manila', created_at timestamptz not null default now()
);
create table public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  role text not null check (role in ('admin','staff','subscriber')),
  status text not null default 'active' check (status in ('active','suspended','deactivated')),
  created_at timestamptz not null default now(), unique (user_id, organization_id)
);
create table public.subscribers (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  user_id uuid, account_number text not null check (account_number ~ '^[A-Z0-9-]{3,30}$'),
  name text not null check (length(name) between 2 and 120), email text not null,
  address text not null, status text not null default 'pending' check (status in ('pending','active','suspended')),
  created_at timestamptz not null default now(), unique (organization_id, account_number),
  unique (id, organization_id), unique (user_id),
  foreign key (user_id, organization_id) references public.memberships(user_id, organization_id)
);
create table public.plans (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check (length(name) between 2 and 100),
  download_mbps integer not null check (download_mbps between 1 and 100000),
  upload_mbps integer not null check (upload_mbps between 1 and 100000),
  price_minor bigint not null check (price_minor between 0 and 9999999999),
  currency text not null check (currency ~ '^[A-Z]{3}$'), created_at timestamptz not null default now(), unique (id, organization_id)
);
create table public.subscriber_services (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  subscriber_id uuid not null, plan_id uuid not null,
  status text not null check (status in ('pending','active','suspended','terminated')),
  created_at timestamptz not null default now(),
  foreign key (subscriber_id, organization_id) references public.subscribers(id, organization_id),
  foreign key (plan_id, organization_id) references public.plans(id, organization_id)
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  subscriber_id uuid not null, number text not null, issued_on date not null, due_on date not null,
  description text not null, total_minor bigint not null check (total_minor between 0 and 9999999999),
  currency text not null check (currency ~ '^[A-Z]{3}$'), created_at timestamptz not null default now(),
  foreign key (subscriber_id, organization_id) references public.subscribers(id, organization_id),
  unique (organization_id, number), unique (id, organization_id, subscriber_id, currency)
);
-- Initial read-only ledger: trusted imports only. Application posting is not yet implemented.
create table public.payments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  subscriber_id uuid not null, reference text not null, amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'), received_at timestamptz not null default now(),
  foreign key (subscriber_id, organization_id) references public.subscribers(id, organization_id),
  unique (organization_id, reference), unique (id, organization_id, subscriber_id, currency)
);
create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, subscriber_id uuid not null,
  currency text not null, invoice_id uuid not null, payment_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  foreign key (invoice_id, organization_id, subscriber_id, currency) references public.invoices(id, organization_id, subscriber_id, currency),
  foreign key (payment_id, organization_id, subscriber_id, currency) references public.payments(id, organization_id, subscriber_id, currency),
  unique (payment_id, invoice_id)
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  actor_id uuid, action text not null, entity_type text not null, entity_id uuid not null,
  created_at timestamptz not null default now()
);

create or replace function app_private.has_access(org uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.organization_id = org
    and m.status = 'active' and m.role = any(roles)
    and (m.role <> 'admin' or (select auth.jwt()->>'aal') = 'aal2'));
$$;
create or replace function app_private.owns_subscriber(subscriber uuid, org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subscribers s join public.memberships m on m.user_id = s.user_id
    where s.id = subscriber and s.organization_id = org and m.organization_id = org
    and m.user_id = (select auth.uid()) and m.status = 'active' and m.role = 'subscriber');
$$;
revoke all on function app_private.has_access(uuid,text[]) from public;
revoke all on function app_private.owns_subscriber(uuid,uuid) from public;
grant execute on function app_private.has_access(uuid,text[]) to authenticated;
grant execute on function app_private.owns_subscriber(uuid,uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.subscribers enable row level security;
alter table public.plans enable row level security;
alter table public.subscriber_services enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.audit_events enable row level security;
revoke all on public.organizations, public.memberships, public.subscribers, public.plans, public.subscriber_services, public.invoices, public.payments, public.payment_allocations, public.audit_events from anon, authenticated;
grant select on public.organizations, public.memberships, public.subscribers, public.plans, public.subscriber_services, public.invoices, public.payments, public.payment_allocations, public.audit_events to authenticated;
-- No role, auth-link, service, financial, update, or delete grants for application clients.
grant insert (organization_id, account_number, name, email, address, status) on public.subscribers to authenticated;
grant insert (organization_id, name, download_mbps, upload_mbps, price_minor, currency) on public.plans to authenticated;
create policy own_membership on public.memberships for select to authenticated using (user_id = (select auth.uid()));
create policy member_organization on public.organizations for select to authenticated using (app_private.has_access(id, array['admin','staff','subscriber']));
create policy subscriber_read on public.subscribers for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or app_private.owns_subscriber(id, organization_id));
create policy subscriber_create on public.subscribers for insert to authenticated with check (
  app_private.has_access(organization_id, array['admin','staff']) and status = 'pending' and user_id is null);
create policy service_read on public.subscriber_services for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or app_private.owns_subscriber(subscriber_id, organization_id));
create policy plan_read on public.plans for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or exists (
    select 1 from public.subscriber_services s where s.plan_id = plans.id and app_private.owns_subscriber(s.subscriber_id, s.organization_id)));
create policy plan_create on public.plans for insert to authenticated with check (
  app_private.has_access(organization_id, array['admin']) and currency = (select o.currency from public.organizations o where o.id = organization_id));
create policy invoice_read on public.invoices for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or app_private.owns_subscriber(subscriber_id, organization_id));
create policy payment_read on public.payments for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or app_private.owns_subscriber(subscriber_id, organization_id));
create policy allocation_read on public.payment_allocations for select to authenticated using (
  app_private.has_access(organization_id, array['admin','staff']) or app_private.owns_subscriber(subscriber_id, organization_id));
create policy audit_read on public.audit_events for select to authenticated using (app_private.has_access(organization_id, array['admin']));

create function app_private.audit_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events(organization_id, actor_id, action, entity_type, entity_id)
  values (new.organization_id, auth.uid(), tg_table_name || '.created', tg_table_name, new.id);
  return new;
end;
$$;
revoke all on function app_private.audit_insert() from public;
create trigger subscribers_audit after insert on public.subscribers for each row execute function app_private.audit_insert();
create trigger plans_audit after insert on public.plans for each row execute function app_private.audit_insert();

-- Concurrent imports lock payment first, then invoice; reject over-allocation.
create function app_private.check_allocation() returns trigger language plpgsql set search_path = '' as $$
declare payment_total bigint; invoice_total bigint; allocated bigint;
begin
  select amount_minor into payment_total from public.payments where id = new.payment_id for update;
  select total_minor into invoice_total from public.invoices where id = new.invoice_id for update;
  select coalesce(sum(amount_minor),0) into allocated from public.payment_allocations where payment_id = new.payment_id;
  if allocated + new.amount_minor > payment_total then raise exception 'Payment over-allocation'; end if;
  select coalesce(sum(amount_minor),0) into allocated from public.payment_allocations where invoice_id = new.invoice_id;
  if allocated + new.amount_minor > invoice_total then raise exception 'Invoice over-allocation'; end if;
  return new;
end;
$$;
revoke all on function app_private.check_allocation() from public;
create trigger allocation_limit before insert on public.payment_allocations for each row execute function app_private.check_allocation();
create function app_private.prevent_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Posted ledger and audit rows are immutable; corrections require an approved reversal workflow'; end;
$$;
revoke all on function app_private.prevent_mutation() from public;
create trigger immutable_invoices before update or delete on public.invoices for each row execute function app_private.prevent_mutation();
create trigger immutable_payments before update or delete on public.payments for each row execute function app_private.prevent_mutation();
create trigger immutable_allocations before update or delete on public.payment_allocations for each row execute function app_private.prevent_mutation();
create trigger immutable_audit before update or delete on public.audit_events for each row execute function app_private.prevent_mutation();
create view public.invoice_balances with (security_invoker = true) as
select i.id, i.organization_id, i.subscriber_id, i.number, i.issued_on, i.due_on, i.total_minor, i.currency,
coalesce((select sum(a.amount_minor) from public.payment_allocations a where a.invoice_id = i.id),0)::bigint as paid_minor
from public.invoices i;
revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to authenticated;
create index on public.subscribers(organization_id, created_at desc);
create index on public.memberships(organization_id);
create index on public.subscriber_services(subscriber_id);
create index on public.subscriber_services(plan_id);
create index on public.invoices(organization_id, due_on);
create index on public.payment_allocations(invoice_id);
create index on public.audit_events(organization_id, created_at desc);
commit;
;
