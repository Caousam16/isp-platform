-- A learned MAC becomes the durable subscriber network identity. The current
-- IP and simple queue may move with DHCP, but a MAC cannot silently belong to
-- two subscribers in the same router scope.
create unique index mikrotik_subscriber_queues_router_mac_unique
  on public.mikrotik_subscriber_queues(organization_id, router_key, mac_address)
  where mac_address is not null;

-- Telemetry may follow the approved MAC to a new DHCP address and its unique
-- static simple queue.
grant update (queue_id, queue_name, target, ip_address, mac_address, dhcp_lease_id, dhcp_host_name, dhcp_status, network_seen_at)
  on public.mikrotik_subscriber_queues to service_role;
