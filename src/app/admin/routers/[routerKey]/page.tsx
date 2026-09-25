import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/access";
import { readAll } from "@/lib/paged-read";
import { configuredRouters, isSnapshotFresh, routerKeySchema } from "@/lib/mikrotik-config";
import { telemetrySchema } from "@/lib/mikrotik";
import { SubscriberDhcpControl } from "@/components/subscriber-dhcp-control";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type SearchParams = {
  page?: string;
  search?: string;
  status?: string;
  mapping?: string;
  queue?: string;
  sort?: string;
  order?: string;
};
const statuses = new Set(["all", "bound", "waiting", "offered", "busy", "unknown"]);
const mappings = new Set(["all", "linked", "unlinked"]);
const queues = new Set(["all", "with", "without"]);
const sorts = new Set(["ip", "mac", "hostname", "status", "queue", "subscriber"]);
const normalize = (value?: string | null) => (value ?? "").trim().toLowerCase();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function queryUrl(routerKey: string, params: SearchParams, page: number) {
  const query = new URLSearchParams();
  for (const field of ["search", "status", "mapping", "queue", "sort", "order"] as const) {
    if (params[field] && params[field] !== "all") query.set(field, params[field]);
  }
  if (page > 1) query.set("page", String(page));
  const suffix = query.toString();
  return "/admin/routers/" + routerKey + (suffix ? "?" + suffix : "");
}

export default async function RouterSnapshotPage({
  params, searchParams,
}: {
  params: Promise<{ routerKey: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ routerKey }, requested] = await Promise.all([params, searchParams]);
  const { client, userId } = await requireRole(["admin"]);
  if (!routerKeySchema.safeParse(routerKey).success) notFound();
  const router = configuredRouters().find((item) => item.routerKey === routerKey);
  if (!router) notFound();
  const { data: adminMemberships, error: membershipError } = await client.from("memberships")
    .select("organization_id").eq("user_id", userId).eq("role", "admin").eq("status", "active");
  if (membershipError || !adminMemberships?.some((item) => item.organization_id === router.organizationId)) notFound();

  const search = (requested.search ?? "").trim().slice(0, 100);
  const status = statuses.has(requested.status ?? "") ? requested.status! : "all";
  const mapping = mappings.has(requested.mapping ?? "") ? requested.mapping! : "all";
  const queueFilter = queues.has(requested.queue ?? "") ? requested.queue! : "all";
  const sort = sorts.has(requested.sort ?? "") ? requested.sort! : "ip";
  const order = requested.order === "desc" ? "desc" : "asc";
  const pageNumber = Math.min(1000, Math.max(1, Math.floor(Number(requested.page) || 1)));
  const filters = { search, status, mapping, queue: queueFilter, sort, order };
  const label = router.displayName ?? router.routerKey;

  const [snapshotResult, bindingsResult, subscribersResult] = await Promise.all([
    client.from("mikrotik_snapshots")
      .select("organization_id,router_key,received_at,collected_at,snapshot")
      .eq("organization_id", router.organizationId).eq("router_key", router.routerKey).maybeSingle(),
    readAll((from, to) => client.from("mikrotik_subscriber_queues")
      .select("organization_id,router_key,subscriber_id,mac_address,queue_name")
      .eq("organization_id", router.organizationId).eq("router_key", router.routerKey)
      .order("subscriber_id").range(from, to)),
    readAll((from, to) => client.from("subscribers")
      .select("organization_id,id,name,account_number,status")
      .eq("organization_id", router.organizationId)
      .in("status", ["pending", "active", "suspended"]).order("id").range(from, to)),
  ]);

  const mappingReady = !bindingsResult.error && !subscribersResult.error;
  const parsed = telemetrySchema.safeParse(snapshotResult.data?.snapshot);
  const snapshot = parsed.success ? parsed.data : null;
  const stale = !isSnapshotFresh(snapshotResult.data?.collected_at ?? snapshotResult.data?.received_at);
  const bindings = bindingsResult.data ?? [];
  const subscribers = subscribersResult.data ?? [];
  const byMac = new Map(bindings.filter((item) => item.mac_address).map((item) => [item.mac_address!.toUpperCase(), item]));
  const bySubscriber = new Map(subscribers.map((item) => [item.id, item]));
  const linkedIds = new Set(bindings.map((item) => item.subscriber_id));
  const availableSubs = subscribers.filter((item) => !linkedIds.has(item.id));
  const queueByIp = new Map((snapshot?.queues ?? [])
    .filter((item) => item.kind === "simple")
    .map((item) => [item.target.replace(/\/32$/, ""), item.name]));

  const rows = (snapshot?.dhcpLeases ?? []).map((lease) => {
    const binding = byMac.get(lease.macAddress.toUpperCase());
    const subscriber = binding ? bySubscriber.get(binding.subscriber_id) : undefined;
    const queueName = binding?.queue_name || queueByIp.get(lease.address) || "";
    return { lease, binding, subscriber, queueName };
  });
  const term = normalize(search);
  const filtered = rows.filter(({ lease, binding, subscriber, queueName }) => {
    if (status !== "all" && (normalize(lease.status) || "unknown") !== status) return false;
    if (mapping === "linked" && !binding) return false;
    if (mapping === "unlinked" && binding) return false;
    if (queueFilter === "with" && !queueName) return false;
    if (queueFilter === "without" && queueName) return false;
    return !term || [
      lease.address, lease.macAddress, lease.hostName, lease.server, lease.status,
      lease.comment, queueName, subscriber?.name, subscriber?.account_number,
    ].some((value) => normalize(value).includes(term));
  });
  const key = (row: typeof rows[number]) => {
    switch (sort) {
      case "mac": return row.lease.macAddress;
      case "hostname": return row.lease.hostName;
      case "status": return row.lease.status;
      case "queue": return row.queueName;
      case "subscriber": return row.subscriber?.name ?? "";
      default: return row.lease.address;
    }
  };
  filtered.sort((a, b) =>
    (order === "asc" ? 1 : -1) * (collator.compare(key(a), key(b)) ||
      collator.compare(a.lease.address, b.lease.address) || collator.compare(a.lease.id, b.lease.id)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(pageNumber, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return (
    <main className="routers-page">
      <header className="page-header">
        <div>
          <Link href="/admin/routers" className="back-link">← All routers</Link>
          <h1>{label} snapshot</h1>
          <p className="page-description">DHCP leases, ONU identities and subscriber links for this router.</p>
        </div>
        <Link href={queryUrl(routerKey, filters, currentPage)} className="btn">Reload saved snapshot</Link>
      </header>
      <nav className="router-tabs" aria-label="Router snapshots">
        {configuredRouters().filter((item) => adminMemberships.some((member) => member.organization_id === item.organizationId)).map((item) => (
          <Link key={item.routerKey} href={"/admin/routers/" + item.routerKey}
            aria-current={item.routerKey === routerKey ? "page" : undefined}
            className={item.routerKey === routerKey ? "router-tab active" : "router-tab"}>
            {item.displayName ?? item.routerKey}
          </Link>
        ))}
      </nav>
      {snapshotResult.error ? (
        <div className="alert-card" role="alert">Could not load this router&apos;s snapshot.</div>
      ) : !snapshotResult.data ? (
        <div className="empty-state">No snapshot has arrived for {label} yet.</div>
      ) : !snapshot ? (
        <div className="alert-card" role="alert">The saved snapshot for {label} is invalid.</div>
      ) : (
        <section className="router-card">
          <div className="router-header">
            <div>
              <div className="router-title-row">
                <h2>{snapshot.identity || label}</h2>
                <span className={"badge " + (stale ? "stale" : "online")}>{stale ? "Stale" : "Recent"}</span>
              </div>
              <p className="router-key">{routerKey} · Received {new Date(snapshotResult.data.received_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</p>
            </div>
            <div className="router-meta">RouterOS {snapshot.version}</div>
          </div>
          {!mappingReady && <div className="alert-card" role="alert">Subscriber mapping is unavailable.</div>}
          <div className="stats-grid router-stats">
            <div className="stat-card"><span>Leases</span><strong>{rows.length}</strong></div>
            <div className="stat-card"><span>Queues</span><strong>{snapshot.queues.length}</strong></div>
            <div className="stat-card"><span>Linked</span><strong>{rows.filter((row) => row.binding).length}</strong></div>
            <div className="stat-card"><span>Matches</span><strong>{filtered.length}</strong></div>
          </div>
          <form method="GET" action={"/admin/routers/" + routerKey} className="router-filters">
            <div className="filter-search">
              <label htmlFor="router-search">Search leases</label>
              <input id="router-search" name="search" type="search" defaultValue={search}
                placeholder="IP, MAC, name, account, queue…" />
            </div>
            <div className="filter-field">
              <label htmlFor="router-status">DHCP status</label>
              <select id="router-status" name="status" defaultValue={status}>
                <option value="all">All statuses</option>
                <option value="bound">Bound</option><option value="waiting">Waiting</option>
                <option value="offered">Offered</option><option value="busy">Busy</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="router-mapping">Subscriber</label>
              <select id="router-mapping" name="mapping" defaultValue={mapping}>
                <option value="all">All mappings</option>
                <option value="linked">Linked</option><option value="unlinked">Unlinked</option>
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="router-queue">Queue</label>
              <select id="router-queue" name="queue" defaultValue={queueFilter}>
                <option value="all">All queues</option>
                <option value="with">With queue</option><option value="without">No queue</option>
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="router-sort">Sort by</label>
              <select id="router-sort" name="sort" defaultValue={sort}>
                <option value="ip">IP address</option><option value="mac">MAC address</option>
                <option value="hostname">Hostname</option><option value="status">DHCP status</option>
                <option value="queue">Queue</option><option value="subscriber">Subscriber</option>
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="router-order">Order</label>
              <select id="router-order" name="order" defaultValue={order}>
                <option value="asc">Ascending</option><option value="desc">Descending</option>
              </select>
            </div>
            <div className="filter-actions">
              <button className="btn primary" type="submit">Apply</button>
              <Link className="btn" href={"/admin/routers/" + routerKey}>Clear</Link>
            </div>
          </form>
          {visible.length ? (
            <>
              <div className="table-wrapper">
                <table className="router-table">
                  <thead><tr><th>IP</th><th>MAC / ONU</th><th>Hostname</th><th>Server</th><th>Status</th><th>Queue</th><th>Subscriber</th></tr></thead>
                  <tbody>
                    {visible.map(({ lease, binding, subscriber, queueName }) => (
                      <tr key={lease.id}>
                        <td><strong>{lease.address}</strong></td>
                        <td className="mono">{lease.macAddress || "—"}</td>
                        <td>{lease.hostName || "—"}</td>
                        <td>{lease.server || "—"}</td>
                        <td><span className={"lease-status lease-" + normalize(lease.status)}>{lease.status || "unknown"}</span></td>
                        <td>{queueName ? <span className="queue-name">{queueName}</span> : <span className="muted">No queue</span>}</td>
                        <td>{!stale && mappingReady ? (
                          <SubscriberDhcpControl routerKey={routerKey} leaseId={lease.id}
                            address={lease.address} macAddress={lease.macAddress}
                            hostName={lease.hostName} subscribers={availableSubs}
                            linked={subscriber} queueName={binding?.queue_name} />
                        ) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <span>Showing {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                <div className="pagination-buttons">
                  {currentPage > 1 ? <Link className="btn" href={queryUrl(routerKey, filters, currentPage - 1)}>← Prev</Link> : <span className="btn disabled">← Prev</span>}
                  <span>Page {currentPage} of {totalPages}</span>
                  {currentPage < totalPages ? <Link className="btn" href={queryUrl(routerKey, filters, currentPage + 1)}>Next →</Link> : <span className="btn disabled">Next →</span>}
                </div>
              </div>
            </>
          ) : <div className="empty-state compact">No leases match these filters.</div>}
        </section>
      )}
    </main>
  );
}
