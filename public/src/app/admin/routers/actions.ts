"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { telemetrySchema } from "@/lib/mikrotik";
import { configuredRouters, routerKeySchema, isSnapshotFresh } from "@/lib/mikrotik-config";
import { z } from "zod";

export async function linkSubscriberDhcp(input: unknown) {
  const { client, userId } = await requireRole(["admin"]);
  const parsed = z.object({ subscriberId: z.uuid(), leaseId: z.string().min(1).max(64), routerKey: routerKeySchema.default("local-test") }).strict().safeParse(input);
  if (!parsed.success) return { error: "Choose one subscriber and DHCP lease." };
  let scope;try{scope=configuredRouters().find(s=>s.routerKey===parsed.data.routerKey);}catch{return {error:"Router configuration is invalid."};}
  if(!scope)return {error:"Router is not configured."};
  const org=scope.organizationId;
  const [{ data: subscriber }, { data: row }] = await Promise.all([
    client.from("subscribers").select("id,status").eq("id", parsed.data.subscriberId).eq("organization_id", org).maybeSingle(),
    client.from("mikrotik_snapshots").select("received_at,collected_at,snapshot").eq("organization_id", org).eq("router_key", scope.routerKey).maybeSingle(),
  ]);
  const snapshot = telemetrySchema.safeParse(row?.snapshot);
  if (!subscriber || !row || !snapshot.success || !isSnapshotFresh(row.collected_at??row.received_at))
    return { error: "Choose a subscriber and refresh the router snapshot." };
  const matches = snapshot.data.dhcpLeases.filter(lease => lease.id === parsed.data.leaseId);
  if (matches.length !== 1) return { error: "DHCP lease is missing or ambiguous. Refresh the router snapshot." };
  const lease = matches[0];
  if (!lease.address || !lease.macAddress) return { error: "DHCP lease must have an IP address and MAC address." };
  if(snapshot.data.dhcpLeases.filter(l=>l.macAddress.toUpperCase()===lease.macAddress.toUpperCase()).length!==1 || snapshot.data.dhcpLeases.filter(l=>l.address===lease.address).length!==1) return {error:"DHCP identity is ambiguous. Resolve duplicate MAC or IP entries."};
  // DHCP establishes the ONU/CPE identity. The simple queue is attached separately
  // by matching its /32 target to the current DHCP address so plan control remains available.
  const queueMatches = snapshot.data.queues.filter(q =>
    q.kind === "simple" && q.target === `${lease.address}/32` && !q.dynamic && !q.disabled &&
    q.parent === "none" && q.packetMarks === "" && Boolean(q.settings));
  if (queueMatches.length > 1) return { error: "Multiple eligible simple queues target this DHCP IP. Resolve the router conflict first." };
  const queue = queueMatches[0];
  const admin = createAdminClient();
  const { error } = await admin.from("mikrotik_subscriber_queues").insert({
    organization_id: org, subscriber_id: subscriber.id, router_key: scope.routerKey,
    queue_id: queue?.id ?? null, queue_name: queue?.name ?? null, target: queue?.target ?? null,
    ip_address: lease.address, mac_address: lease.macAddress.toUpperCase(),
    dhcp_lease_id: lease.id, dhcp_host_name: lease.hostName || null,
    dhcp_status: lease.status || null, network_seen_at: new Date().toISOString(),
  });
  if (error) return { error: error.code === "23505" ? "This DHCP IP, MAC, or subscriber is already linked." : "Could not link DHCP identity. Apply the DHCP-only migration." };
  revalidatePath("/admin/routers"); revalidatePath("/admin");
  return { message: queue ? `ONU linked at ${lease.address}; queue ${queue.name} is ready for plan control.` : `ONU linked at ${lease.address}. No eligible simple queue currently targets this IP; plan control will attach automatically when one appears.` };
}


export async function linkSubscriberQueue(input:unknown){
 const {client}=await requireRole(["admin"]);
 const p=z.object({subscriberId:z.uuid(),queueId:z.string().min(1).max(64)}).strict().safeParse(input);
 if(!p.success)return {error:"Invalid queue selection."};
 const {data}=await client.from("mikrotik_subscriber_queues").select("queue_id").eq("subscriber_id",p.data.subscriberId).maybeSingle();
 return data?.queue_id===p.data.queueId?{message:"Queue is already attached to this DHCP identity."}:{error:"Queue attachment follows the fresh DHCP snapshot. Refresh and verify the ONU identity."};
}
export async function unlinkSubscriberQueue(input:unknown){
 const {client}=await requireRole(["admin"]);const p=z.uuid().safeParse(input);if(!p.success)return {error:"Invalid subscriber."};
 const {error}=await client.rpc("unlink_subscriber_router",{p_subscriber:p.data});
 if(error)return {error:"Could not unlink. Reconcile running or uncertain commands first."};
 revalidatePath("/admin/routers");revalidatePath("/admin");return {message:"DHCP / ONU link removed."};
}
export async function syncSubscriberQueue(input:unknown){
 const {client}=await requireRole(["admin"]);const p=z.uuid().safeParse(input);if(!p.success)return {error:"Invalid subscriber."};
 const {data,error}=await client.rpc("sync_subscriber_router",{p_subscriber:p.data});
 if(error)return {error:"Could not queue synchronization. Check snapshot freshness, eligible queue and outstanding commands."};
 revalidatePath("/admin/routers");return {message:data?"Plan synchronization queued. Check command history for confirmation.":"No eligible mapped service to synchronize."};
}
