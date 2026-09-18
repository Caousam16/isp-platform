-- Allow the trusted telemetry route to refresh DHCP identity on already-approved subscriber mappings.
-- RLS remains enabled; the service role is used by the server-side telemetry route.
grant update (ip_address, mac_address, dhcp_lease_id, dhcp_host_name, dhcp_status, network_seen_at)
  on public.mikrotik_subscriber_queues to service_role;
