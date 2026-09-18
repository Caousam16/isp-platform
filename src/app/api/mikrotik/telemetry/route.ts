import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readTelemetry, validConnectorToken } from "@/lib/mikrotik";

export const runtime = "nodejs";
export const maxDuration = 30;
const reply = (status: number, message: string) => Response.json(
  { message }, { status, headers: { "Cache-Control": "no-store" } },
);

export async function POST(request: Request) {
  // One test router, explicitly bound to its company by server configuration.
  // Never accept tenant IDs, router addresses or commands from a request.
  const org = z.uuid().safeParse(process.env.MIKROTIK_ORGANIZATION_ID);
  const hash = process.env.MIKROTIK_CONNECTOR_TOKEN_SHA256 ?? "";
  if (!org.success || !/^[a-f0-9]{64}$/.test(hash)) return reply(503, "Connector not configured");
  if (!validConnectorToken(request.headers.get("authorization"), hash)) return reply(401, "Unauthorized");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return reply(415, "JSON required");
  let snapshot;
  try { snapshot = await readTelemetry(request); }
  catch { return reply(400, "Invalid or oversized snapshot"); }
  try {
    const admin = createAdminClient();
    const receivedAt = new Date().toISOString();
    const { error } = await admin.from("mikrotik_snapshots").upsert({
      organization_id: org.data,
      router_key: "local-test",
      received_at: receivedAt,
      snapshot,
    }, { onConflict: "organization_id,router_key" });
    if (error) return reply(503, "Snapshot storage unavailable");

    // DHCP is the only subscriber network identity source. Once linked, the
    // MAC identifies the ONU/CPE and DHCP supplies its current IP/hostname.
    const { data: mappings, error: mappingReadError } = await admin
      .from("mikrotik_subscriber_queues")
      .select("subscriber_id,mac_address,queue_id,queue_name,target")
      .eq("organization_id", org.data).eq("router_key", "local-test");
    if (!mappingReadError && mappings) {
      for (const mapping of mappings) {
        if (!mapping.mac_address) continue;
        const matches = snapshot.dhcpLeases.filter(lease =>
          lease.macAddress && lease.macAddress.toUpperCase() === mapping.mac_address.toUpperCase());
        if (matches.length !== 1) continue;
        const lease = matches[0];
        const ipOwned = mappings.some(other => other.subscriber_id !== mapping.subscriber_id &&
          snapshot.dhcpLeases.some(l => l.address === lease.address && l.macAddress?.toUpperCase() === other.mac_address?.toUpperCase()));
        if (ipOwned) continue;
        const queueMatches = snapshot.queues.filter(q => q.kind === "simple" && q.target === `${lease.address}/32` &&
          !q.dynamic && !q.disabled && q.parent === "none" && q.packetMarks === "" && Boolean(q.settings));
        const queue = queueMatches.length === 1 ? queueMatches[0] : null;
        await admin.from("mikrotik_subscriber_queues").update({
          ip_address: lease.address,
          dhcp_lease_id: lease.id || null,
          dhcp_host_name: lease.hostName || null,
          dhcp_status: lease.status || null,
          network_seen_at: receivedAt,
          // Queue is the traffic-control attachment, not the subscriber identity.
          // Rebind it only when exactly one eligible queue targets the DHCP IP.
          queue_id: queue?.id ?? null,
          queue_name: queue?.name ?? null,
          target: queue?.target ?? null,
        }).eq("organization_id", org.data).eq("subscriber_id", mapping.subscriber_id);
      }
    }
    return reply(200, "Snapshot received");
  } catch { return reply(503, "Snapshot storage unavailable"); }
}
