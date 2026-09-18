"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { telemetrySchema } from "@/lib/mikrotik";
import { queueServiceRouterSync } from "@/lib/router-service-sync";
import { z } from "zod";

export async function linkSubscriberDhcp(input: unknown) {
  const { client, userId } = await requireRole(["admin"]);
  const parsed = z.object({ subscriberId: z.uuid(), leaseId: z.string().min(1).max(64) }).strict().safeParse(input);
  if (!parsed.success) return { error: "Choose one subscriber and DHCP lease." };
  const org = process.env.MIKROTIK_ORGANIZATION_ID;
  if (!org) return { error: "Router company is not configured." };
  const { data: membership } = await client.from("memberships").select("role").eq("user_id", userId)
    .eq("organization_id", org).eq("role", "admin").eq("status", "active").maybeSingle();
  if (!membership) return { error: "Active admin membership is required." };
  const [{ data: subscriber }, { data: row }] = await Promise.all([
    client.from("subscribers").select("id,status").eq("id", parsed.data.subscriberId).eq("organization_id", org).maybeSingle(),
    client.from("mikrotik_snapshots").select("received_at,snapshot").eq("organization_id", org).eq("router_key", "local-test").maybeSingle(),
  ]);
  const snapshot = telemetrySchema.safeParse(row?.snapshot);
  if (!subscriber || !row || !snapshot.success || Date.now() - Date.parse(row.received_at) > 180_000)
    return { error: "Choose a subscriber and refresh the router snapshot." };
  const matches = snapshot.data.dhcpLeases.filter(lease => lease.id === parsed.data.leaseId);
  if (matches.length !== 1) return { error: "DHCP lease is missing or ambiguous. Refresh the router snapshot." };
  const lease = matches[0];
  if (!lease.address || !lease.macAddress) return { error: "DHCP lease must have an IP address and MAC address." };
  // DHCP establishes the ONU/CPE identity. The simple queue is attached separately
  // by matching its /32 target to the current DHCP address so plan control remains available.
  const queueMatches = snapshot.data.queues.filter(q =>
    q.kind === "simple" && q.target === `${lease.address}/32` && !q.dynamic && !q.disabled &&
    q.parent === "none" && q.packetMarks === "" && Boolean(q.settings));
  if (queueMatches.length > 1) return { error: "Multiple eligible simple queues target this DHCP IP. Resolve the router conflict first." };
  const queue = queueMatches[0];
  const admin = createAdminClient();
  const { error } = await admin.from("mikrotik_subscriber_queues").insert({
    organization_id: org, subscriber_id: subscriber.id, router_key: "local-test",
    queue_id: queue?.id ?? null, queue_name: queue?.name ?? null, target: queue?.target ?? null,
    ip_address: lease.address, mac_address: lease.macAddress.toUpperCase(),
    dhcp_lease_id: lease.id, dhcp_host_name: lease.hostName || null,
    dhcp_status: lease.status || null, network_seen_at: new Date().toISOString(),
  });
  if (error) return { error: error.code === "23505" ? "This DHCP IP, MAC, or subscriber is already linked." : "Could not link DHCP identity. Apply the DHCP-only migration." };
  revalidatePath("/admin/routers"); revalidatePath("/admin");
  return { message: queue ? `ONU linked at ${lease.address}; queue ${queue.name} is ready for plan control.` : `ONU linked at ${lease.address}. No eligible simple queue currently targets this IP; plan control will attach automatically when one appears.` };
}

// Compatibility/manual queue-link action. DHCP remains the subscriber/ONU identity;
// this action only attaches an eligible Simple Queue for plan/bandwidth control.
export async function linkSubscriberQueue(input: unknown) {
  const { client, userId } = await requireRole(["admin"]);
  const parsed = z.object({ subscriberId: z.uuid(), queueId: z.string().min(1).max(64) }).strict().safeParse(input);
  const org = process.env.MIKROTIK_ORGANIZATION_ID;
  if (!org || !parsed.success) return { error: "Choose one subscriber and a valid queue." };

  const { data: membership } = await client.from("memberships").select("role").eq("user_id", userId)
    .eq("organization_id", org).eq("role", "admin").eq("status", "active").maybeSingle();
  if (!membership) return { error: "Active admin membership is required." };

  const [{ data: mapping }, { data: row }] = await Promise.all([
    client.from("mikrotik_subscriber_queues").select("subscriber_id,ip_address,mac_address,dhcp_lease_id,dhcp_host_name,dhcp_status")
      .eq("organization_id", org).eq("subscriber_id", parsed.data.subscriberId).maybeSingle(),
    client.from("mikrotik_snapshots").select("received_at,snapshot").eq("organization_id", org).eq("router_key", "local-test").maybeSingle(),
  ]);
  const snapshot = telemetrySchema.safeParse(row?.snapshot);
  if (!mapping?.ip_address) return { error: "Link the subscriber to a DHCP lease / ONU first." };
  if (!row || !snapshot.success || Date.now() - Date.parse(row.received_at) > 180_000)
    return { error: "Refresh the router snapshot before linking the queue." };

  const queue = snapshot.data.queues.find(q => q.kind === "simple" && q.id === parsed.data.queueId);
  if (!queue || queue.dynamic || queue.disabled || queue.parent !== "none" || queue.packetMarks !== "" || !queue.settings)
    return { error: "Only an enabled static simple queue can be used for plan control." };
  if (queue.target !== `${mapping.ip_address}/32`)
    return { error: `Queue target ${queue.target} does not match the subscriber DHCP IP ${mapping.ip_address}/32.` };

  const { error } = await createAdminClient().from("mikrotik_subscriber_queues").update({
    queue_id: queue.id, queue_name: queue.name, target: queue.target,
  }).eq("organization_id", org).eq("subscriber_id", parsed.data.subscriberId);
  if (error) return { error: "Could not attach the queue to this DHCP subscriber." };

  revalidatePath("/admin/routers"); revalidatePath("/admin");
  return { message: `Queue ${queue.name} attached for plan control. DHCP remains the ONU identity.` };
}

export async function unlinkSubscriberQueue(input: unknown) {
  const { client, userId } = await requireRole(["admin"]);
  const parsed = z.uuid().safeParse(input);
  const org = process.env.MIKROTIK_ORGANIZATION_ID;
  if (!org || !parsed.success) return { error: "Invalid mapping." };
  const { data: membership } = await client.from("memberships").select("role").eq("user_id",userId)
    .eq("organization_id",org).eq("role","admin").eq("status","active").maybeSingle();
  if (!membership) return { error: "Active admin membership is required." };
  const { error } = await createAdminClient().from("mikrotik_subscriber_queues").delete()
    .eq("organization_id",org).eq("subscriber_id",parsed.data);
  if (error) return { error: "Could not unlink mapping." };
  revalidatePath("/admin/routers");
  return { message: "DHCP / ONU link removed." };
}


export async function syncSubscriberQueue(input: unknown) {
  const { client, userId } = await requireRole(["admin"]);
  const parsed = z.uuid().safeParse(input);
  const org = process.env.MIKROTIK_ORGANIZATION_ID;
  if (!org || !parsed.success) return { error: "Choose a linked subscriber." };
  const { data: membership } = await client.from("memberships").select("role").eq("user_id",userId)
    .eq("organization_id",org).eq("role","admin").eq("status","active").maybeSingle();
  if (!membership) return { error: "Active admin membership is required." };
  const { data: mapping } = await client.from("mikrotik_subscriber_queues").select("queue_id")
    .eq("organization_id",org).eq("subscriber_id",parsed.data).maybeSingle();
  if (!mapping?.queue_id) return { error: "ONU is linked, but no simple queue currently targets its DHCP IP." };
  const { data: services } = await client.from("subscriber_services")
    .select("id,organization_id,subscriber_id,plan_id,status")
    .eq("organization_id",org).eq("subscriber_id",parsed.data).in("status",["active","suspended","terminated"]);
  const current = (services ?? []).filter(service => service.status !== "terminated");
  const selected = current.length ? current : services ?? [];
  if (selected.length !== 1) return { error: "One unambiguous current service is required." };
  const message = await queueServiceRouterSync(selected[0] as import("@/lib/domain").Service,userId);
  revalidatePath("/admin/routers");
  return { message };
}
