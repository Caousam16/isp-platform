import Link from "next/link";
import { requireRole } from "@/lib/access";
import { configuredRouters, isSnapshotFresh } from "@/lib/mikrotik-config";

export const dynamic = "force-dynamic";

export default async function RoutersPage() {
  const { client, userId } = await requireRole(["admin"]);
  const [membershipResult, snapshotResult] = await Promise.all([
    client.from("memberships").select("organization_id")
      .eq("user_id", userId).eq("role", "admin").eq("status", "active"),
    client.from("mikrotik_snapshots")
      .select("organization_id,router_key,received_at,collected_at"),
  ]);
  const allowed = new Set((membershipResult.data ?? []).map((item) => item.organization_id));
  const routers = membershipResult.error ? [] : configuredRouters().filter((item) => allowed.has(item.organizationId));
  const { data: snapshots, error } = snapshotResult;

  return (
    <main className="routers-page">
      <header className="page-header">
        <div>
          <Link href="/admin" className="back-link">← Workspace</Link>
          <h1>Router snapshots</h1>
          <p className="page-description">Choose a router to view its DHCP leases, subscriber links and queues.</p>
        </div>
      </header>
      {(error || membershipResult.error) && <div className="alert-card" role="alert">Could not load router snapshot status.</div>}
      {!membershipResult.error && !routers.length ? (
        <div className="empty-state">No routers are configured.</div>
      ) : (
        <div className="router-overview">
          {routers.map((router) => {
            const snapshot = snapshots?.find((row) =>
              row.organization_id === router.organizationId && row.router_key === router.routerKey);
            const timestamp = snapshot?.collected_at ?? snapshot?.received_at;
            return (
              <Link className="router-overview-card" href={"/admin/routers/" + router.routerKey} key={router.routerKey}>
                <span className="router-overview-label">{router.displayName ?? router.routerKey}</span>
                <span className={"badge " + (timestamp && isSnapshotFresh(timestamp) ? "online" : "stale")}>
                  {!timestamp ? "No snapshot" : isSnapshotFresh(timestamp) ? "Recent" : "Stale"}
                </span>
                <span className="router-key">{router.routerKey}</span>
                <span className="router-overview-time">
                  {snapshot?.received_at ? "Last received " + new Date(snapshot.received_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : "Waiting for first snapshot"}
                </span>
                <span className="router-overview-open">View snapshot →</span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
