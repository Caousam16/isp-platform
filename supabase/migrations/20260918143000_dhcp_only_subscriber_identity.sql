-- DHCP is the subscriber-to-MikroTik ONU identity source. Queue data is no
-- longer required for a subscriber network binding.
alter table public.mikrotik_subscriber_queues
  alter column queue_id drop not null,
  alter column queue_name drop not null,
  alter column target drop not null;

alter table public.mikrotik_subscriber_queues
  drop constraint if exists mikrotik_subscriber_queues_queue_id_check,
  drop constraint if exists mikrotik_subscriber_queues_target_check;

grant update (ip_address, mac_address, dhcp_lease_id, dhcp_host_name, dhcp_status, network_seen_at)
  on public.mikrotik_subscriber_queues to service_role;
