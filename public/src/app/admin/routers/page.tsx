import { SubscriberDhcpControl } from "@/components/subscriber-dhcp-control";
import { readAll } from "@/lib/paged-read";
import { isSnapshotFresh } from "@/lib/mikrotik-config";
import Link from "next/link";
import { requireRole } from "@/lib/access";
import { telemetrySchema } from "@/lib/mikrotik";

export const dynamic = "force-dynamic";

export default async function RoutersPage({searchParams}:{searchParams:Promise<{page?:string}>}) {
  const params=await searchParams;
  const page=Math.min(100,Math.max(1,Math.floor(Number(params.page)||1)));
  const { client } = await requireRole(["admin"]);
  const { data, error } = await client.from("mikrotik_snapshots")
    .select("organization_id, router_key, received_at, collected_at, snapshot")
    .order("received_at", { ascending: false });
  const [bindingsResult, subscribersResult] = await Promise.all([
    readAll((from,to)=>client.from("mikrotik_subscriber_queues").select("organization_id,router_key,subscriber_id,queue_id,queue_name,target,ip_address,mac_address,dhcp_lease_id,dhcp_host_name,dhcp_status,network_seen_at").order("subscriber_id").range(from,to)),
    readAll((from,to)=>client.from("subscribers").select("organization_id,id,name,account_number,status").in("status",["pending","active","suspended"]).order("id").range(from,to)),
  ]);
  const mappingReady = !bindingsResult.error && !subscribersResult.error;
  const subscriberOptions = (subscribersResult.data ?? []).map(subscriber => ({
    organization_id:subscriber.organization_id, id: subscriber.id, name: subscriber.name, account_number: subscriber.account_number, status: subscriber.status,
  }));
  return <main style={{ padding: "2rem", maxWidth: 1300, margin: "auto" }}>
    <Link href="/admin">← Workspace</Link>
    <h1>MikroTik DHCP / ONU identity</h1>
    <p>DHCP is the subscriber network identity source. Link the web-app subscriber to the MikroTik DHCP lease for the subscriber ONU/CPE.</p>
    <p>The lease MAC remains the ONU identity; its DHCP IP can change and will be refreshed automatically.</p>
    {!mappingReady && <p role="alert">Subscriber mapping is unavailable. Apply the DHCP subscriber identity migration to link a subscriber.</p>}
    <p><a href="/admin/routers">Refresh snapshots</a></p>
    {error ? <p role="alert">Could not load snapshots. Check that the MikroTik migration has been applied.</p>
      : !data?.length ? <p>No snapshots yet. Configure and start the local connector, then refresh this page.</p>
      : data.map(row => {
        const parsed = telemetrySchema.safeParse(row.snapshot);
        if (!parsed.success) return <p key={row.organization_id}>Invalid stored snapshot.</p>;
        const snapshot = parsed.data;
        const stale = !isSnapshotFresh(row.collected_at??row.received_at);
        const bindings=(bindingsResult.data??[]).filter(b=>b.organization_id===row.organization_id&&b.router_key===row.router_key);
        const linkedIds=new Set((bindingsResult.data??[]).map(b=>b.subscriber_id));
        const options=subscriberOptions.filter(s=>s.organization_id===row.organization_id&&!linkedIds.has(s.id));
        const leasePage=Math.min(page,Math.max(1,Math.ceil(snapshot.dhcpLeases.length/50)));
        return <section className="panel" key={`${row.organization_id}:${row.router_key}`} style={{ marginTop: 24, padding: 24 }}>
          <h2>{snapshot.identity || "Unnamed router"} · {row.router_key}</h2>
          <datalist id={`subscribers-${row.router_key}`}>{options.map(s=><option key={s.id} value={s.account_number}>{s.name}</option>)}</datalist>
          <p>{stale ? "Stale — check connector and router" : "Recent snapshot received"} · RouterOS {snapshot.version} · Uptime {snapshot.uptime}</p>
          <p>Company ID: {row.organization_id}<br />Received: {new Date(row.received_at).toISOString()} · {snapshot.queues.length} queues · {snapshot.dhcpLeases.length} DHCP leases</p>
          <div style={{ overflowX: "auto" }}><table>
            <caption>DHCP leases at last successful collection</caption>
            <thead><tr><th>Target IP</th><th>MAC / ONU</th><th>Hostname</th><th>DHCP server</th><th>Status</th><th>Queue / plan control</th><th>Subscriber</th></tr></thead>
            <tbody>{snapshot.dhcpLeases.slice((leasePage-1)*50,leasePage*50).map(lease => {
              const binding = bindings.find(item => item.mac_address?.toUpperCase() === lease.macAddress?.toUpperCase());
              const linked = binding ? subscriberOptions.find(option => option.id === binding.subscriber_id) : undefined;
              return <tr key={lease.id}>
                <td><strong>{lease.address}</strong></td><td>{lease.macAddress || "—"}</td><td>{lease.hostName || "—"}</td>
                <td>{lease.server || "—"}</td><td>{lease.status || "unknown"}</td><td>{binding?.queue_name || "No queue for this IP"}</td>
                <td>{!stale && mappingReady ? <SubscriberDhcpControl routerKey={row.router_key} leaseId={lease.id} address={lease.address} macAddress={lease.macAddress}
                  hostName={lease.hostName} subscribers={options} linked={linked} queueName={binding?.queue_name} /> : "—"}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <nav aria-label="DHCP pages">{leasePage>1 && <Link href={`?page=${leasePage-1}`}>Previous </Link>} Page {leasePage} of {Math.max(1,Math.ceil(snapshot.dhcpLeases.length/50))} {leasePage*50<snapshot.dhcpLeases.length && <Link href={`?page=${leasePage+1}`}> Next</Link>}</nav>
          {!snapshot.dhcpLeases.length && <p>The router returned no DHCP leases.</p>}
        </section>;
      })}


  </main>;
}
