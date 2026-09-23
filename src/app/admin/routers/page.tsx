import Link from "next/link";
import { readAll } from "@/lib/paged-read";
import { requireRole } from "@/lib/access";
import { isSnapshotFresh } from "@/lib/mikrotik-config";
import { telemetrySchema } from "@/lib/mikrotik";
import { SubscriberDhcpControl } from "@/components/subscriber-dhcp-control";
import { SearchFilter } from "@/components/search-filter"; // Import the client component

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type SearchParams = {
  page?: string;
  search?: string;
  status?: string;
  mapping?: string;
};

const normalize = (val?: string | null) => (val ?? "").trim().toLowerCase();

function buildQuery(params: SearchParams, updates: Partial<SearchParams>) {
  const next = new URLSearchParams();
  const merged = { ...params, ...updates };

  if (merged.search) next.set("search", merged.search);
  if (merged.status && merged.status !== "all") next.set("status", merged.status);
  if (merged.mapping && merged.mapping !== "all") next.set("mapping", merged.mapping);
  if (merged.page && merged.page !== "1") next.set("page", merged.page);

  const query = next.toString();
  return query ? `?${query}` : "/admin/routers";
}

export default async function RoutersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = Math.min(100, Math.max(1, Math.floor(Number(params.page) || 1)));
  const search = (params.search ?? "").trim();
  const normSearch = normalize(search);
  const statusFilter = params.status ?? "all";
  const mappingFilter = params.mapping ?? "all";

  const { client } = await requireRole(["admin"]);

  const [{ data: snapshots, error }, bindingsRes, subscribersRes] = await Promise.all([
    client.from("mikrotik_snapshots").select("organization_id, router_key, received_at, collected_at, snapshot").order("received_at", { ascending: false }),
    readAll((from, to) => client.from("mikrotik_subscriber_queues").select("*").order("subscriber_id").range(from, to)),
    readAll((from, to) => client.from("subscribers").select("organization_id, id, name, account_number, status").in("status", ["pending", "active", "suspended"]).order("id").range(from, to)),
  ]);

  const mappingReady = !bindingsRes.error && !subscribersRes.error;
  const subscribers = subscribersRes.data ?? [];
  const allBindings = bindingsRes.data ?? [];

  return (
    <main className="routers-page">
      {/* Header */}
      <div className="page-header">
        <div>
          <Link href="/admin" className="back-link">← Workspace</Link>
          <h1>MikroTik DHCP / ONU Identity</h1>
          <p className="page-description">Link subscriber accounts to MikroTik DHCP leases and monitor ONU/CPE network identities.</p>
        </div>
        <Link href="/admin/routers" className="btn">Refresh snapshots</Link>
      </div>

      <div className="info-card">
        <strong>Network identity</strong>
        <p>DHCP is the subscriber network identity source. The lease MAC remains the ONU/CPE identity while its DHCP IP can change and refresh automatically.</p>
      </div>

      {!mappingReady && (
        <div className="alert-card" role="alert">
          Subscriber mapping is unavailable. Apply the DHCP subscriber identity migration.
        </div>
      )}

      {/* Filters (Search uses live updating client component) */}
      <form method="GET" className="filter-card">
        <SearchFilter defaultValue={search} />

        <div className="filter-field">
          <label htmlFor="status">DHCP status</label>
          <select id="status" name="status" defaultValue={statusFilter}>
            <option value="all">All statuses</option>
            <option value="bound">Bound</option>
            <option value="waiting">Waiting</option>
            <option value="offered">Offered</option>
            <option value="busy">Busy</option>
          </select>
        </div>

        <div className="filter-field">
          <label htmlFor="mapping">Subscriber</label>
          <select id="mapping" name="mapping" defaultValue={mappingFilter}>
            <option value="all">All mappings</option>
            <option value="linked">Linked</option>
            <option value="unlinked">Unlinked</option>
          </select>
        </div>

        <div className="filter-actions">
          <button type="submit" className="btn primary">Apply filters</button>
          {(search || statusFilter !== "all" || mappingFilter !== "all") && (
            <Link href="/admin/routers" className="btn">Clear</Link>
          )}
        </div>
      </form>

      {error ? (
        <div className="alert-card" role="alert">Could not load snapshots.</div>
      ) : !snapshots?.length ? (
        <div className="empty-state"><h2>No router snapshots found</h2></div>
      ) : (
        snapshots.map((row) => {
          const parsed = telemetrySchema.safeParse(row.snapshot);
          if (!parsed.success) return <div key={row.router_key} className="alert-card">Invalid snapshot for {row.router_key}</div>;

          const snapshot = parsed.data;
          const stale = !isSnapshotFresh(row.collected_at ?? row.received_at);
          const routerBindings = allBindings.filter(b => b.organization_id === row.organization_id && b.router_key === row.router_key);
          const linkedIds = new Set(routerBindings.map(b => b.subscriber_id));
          const availableSubs = subscribers.filter(s => s.organization_id === row.organization_id && !linkedIds.has(s.id));

          const filteredLeases = snapshot.dhcpLeases.filter((lease) => {
            const binding = routerBindings.find(b => b.mac_address?.toUpperCase() === lease.macAddress?.toUpperCase());
            const linkedSub = subscribers.find(s => s.id === binding?.subscriber_id);

            if (statusFilter !== "all" && normalize(lease.status) !== normalize(statusFilter)) return false;
            if (mappingFilter === "linked" && !binding) return false;
            if (mappingFilter === "unlinked" && binding) return false;

            if (normSearch) {
              const searchable = [lease.address, lease.macAddress, lease.hostName, lease.server, lease.status, binding?.queue_name, linkedSub?.name].filter(Boolean).join(" ").toLowerCase();
              if (!searchable.includes(normSearch)) return false;
            }
            return true;
          });

          const totalPages = Math.max(1, Math.ceil(filteredLeases.length / PAGE_SIZE));
          const leasePage = Math.min(page, totalPages);
          const pageStart = (leasePage - 1) * PAGE_SIZE;
          const paginatedLeases = filteredLeases.slice(pageStart, pageStart + PAGE_SIZE);
          const linkedCount = snapshot.dhcpLeases.filter(l => routerBindings.some(b => b.mac_address?.toUpperCase() === l.macAddress?.toUpperCase())).length;

          return (
            <section className="router-card" key={`${row.organization_id}:${row.router_key}`}>
              <div className="router-header">
                <div>
                  <div className="router-title-row">
                    <h2>{snapshot.identity || "Unnamed router"}</h2>
                    <span className={`badge ${stale ? "stale" : "online"}`}>{stale ? "Stale" : "Recent"}</span>
                  </div>
                  <p className="router-key">{row.router_key}</p>
                </div>
                <div className="router-meta">RouterOS {snapshot.version}</div>
              </div>

              <div className="stats-grid">
                <div className="stat-card"><span>Leases</span><strong>{snapshot.dhcpLeases.length}</strong></div>
                <div className="stat-card"><span>Queues</span><strong>{snapshot.queues.length}</strong></div>
                <div className="stat-card"><span>Linked</span><strong>{linkedCount}</strong></div>
                <div className="stat-card"><span>Showing</span><strong>{filteredLeases.length}</strong></div>
              </div>

              {paginatedLeases.length ? (
                <>
                  <div className="table-wrapper">
                    <table className="router-table">
                      <thead>
                        <tr>
                          <th>IP</th>
                          <th>MAC / ONU</th>
                          <th>Hostname</th>
                          <th>Server</th>
                          <th>Status</th>
                          <th>Queue</th>
                          <th>Subscriber</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedLeases.map((lease) => {
                          const binding = routerBindings.find(b => b.mac_address?.toUpperCase() === lease.macAddress?.toUpperCase());
                          const linked = subscribers.find(s => s.id === binding?.subscriber_id);

                          return (
                            <tr key={lease.id}>
                              <td><strong>{lease.address}</strong></td>
                              <td className="mono">{lease.macAddress || "—"}</td>
                              <td>{lease.hostName || "—"}</td>
                              <td>{lease.server || "—"}</td>
                              <td><span className={`lease-status lease-${normalize(lease.status)}`}>{lease.status || "unknown"}</span></td>
                              <td>{binding?.queue_name ? <span className="queue-name">{binding.queue_name}</span> : <span className="muted">No queue</span>}</td>
                              <td>
                                {!stale && mappingReady ? (
                                  <SubscriberDhcpControl
                                    routerKey={row.router_key}
                                    leaseId={lease.id}
                                    address={lease.address}
                                    macAddress={lease.macAddress}
                                    hostName={lease.hostName}
                                    subscribers={availableSubs}
                                    linked={linked}
                                    queueName={binding?.queue_name}
                                  />
                                ) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="pagination">
                    <span className="pagination-summary">Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredLeases.length)} of {filteredLeases.length}</span>
                    <div className="pagination-buttons">
                      {leasePage > 1 ? <Link className="btn" href={buildQuery(params, { page: String(leasePage - 1) })}>← Prev</Link> : <span className="btn disabled">← Prev</span>}
                      <span>Page {leasePage} of {totalPages}</span>
                      {leasePage < totalPages ? <Link className="btn" href={buildQuery(params, { page: String(leasePage + 1) })}>Next →</Link> : <span className="btn disabled">Next →</span>}
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state compact"><h3>No leases match current filters</h3></div>
              )}
            </section>
          );
        })
      )}
    </main>
  );
}