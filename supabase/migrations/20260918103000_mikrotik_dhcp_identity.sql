-- Persist the DHCP identity observed when an administrator links a subscriber queue.
-- The subscriber record remains the authority for the customer name; MikroTik supplies IP/MAC identity.
alter table public.mikrotik_subscriber_queues
  add column ip_address inet,
  add column mac_address text,
  add column dhcp_lease_id text,
  add column dhcp_host_name text,
  add column dhcp_status text,
  add column network_seen_at timestamptz;

update public.mikrotik_subscriber_queues
set ip_address = split_part(target, '/', 1)::inet
where ip_address is null;

alter table public.mikrotik_subscriber_queues
  alter column ip_address set not null,
  add constraint mikrotik_subscriber_queues_mac_format
    check (mac_address is null or mac_address ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$');

create index mikrotik_subscriber_queues_mac on public.mikrotik_subscriber_queues(organization_id, mac_address)
  where mac_address is not null;
