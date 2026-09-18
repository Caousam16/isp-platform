import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { telemetrySchema } from "@/lib/mikrotik";
import { planSettings, queueIdentitySchema, restrictedSettings, settingsSchema } from "@/lib/mikrotik-bandwidth";
import type { Service } from "@/lib/domain";

// Called after the service mutation. A returned notice describes the state of router
// synchronization; never imply a queued command has already changed traffic.
export async function queueServiceRouterSync(service: Service, userId: string): Promise<string> {
  if (service.status === "pending") return "Pending service recorded. Router provisioning starts when the service is activated.";
  const org = process.env.MIKROTIK_ORGANIZATION_ID;
  if (!org || service.organization_id !== org) return "No router is configured for this company; service status was recorded only.";
  try {
    const db = createAdminClient();
    const [{data: mapping}, {data: row}, {data: plan}] = await Promise.all([
      db.from("mikrotik_subscriber_queues").select("queue_id,queue_name,target")
        .eq("organization_id",org).eq("subscriber_id",service.subscriber_id).maybeSingle(),
      db.from("mikrotik_snapshots").select("received_at,snapshot")
        .eq("organization_id",org).eq("router_key","local-test").maybeSingle(),
      db.from("plans").select("download_mbps,upload_mbps")
        .eq("organization_id",org).eq("id",service.plan_id).maybeSingle(),
    ]);
    if (!mapping) return "No subscriber-to-queue mapping exists. Service status was recorded; router traffic was not changed.";
    const snapshot = telemetrySchema.safeParse(row?.snapshot);
    if (!row || !snapshot.success || Date.now()-Date.parse(row.received_at)>180_000)
      return "Router snapshot is stale. Service status was recorded, but router traffic has not been updated.";
    const q = snapshot.data.queues.find(item => item.kind==="simple" && item.id===mapping.queue_id);
    if (!q || q.name!==mapping.queue_name || q.target!==mapping.target || q.parent!=="none" || q.disabled || q.dynamic || q.packetMarks!=="" || !q.settings)
      return "Queue identity or eligibility changed. Service status was recorded; router traffic was not changed.";
    const identity = queueIdentitySchema.parse({id:q.id,name:q.name,target:q.target});
    const expected = settingsSchema.parse(q.settings);
    if (service.status === "active" && !plan)
      return "Service was recorded, but its plan could not be read. Router traffic was not changed.";
    const desired = service.status === "active"
      ? planSettings(plan!.download_mbps,plan!.upload_mbps) : restrictedSettings();
    // Expire an older pending plan/status request before inserting the newest intent.
    const {error: expireError} = await db.from("mikrotik_bandwidth_jobs")
      .update({status:"expired",finished_at:new Date().toISOString(),result_code:"profile_replaced"})
      .eq("organization_id",org).eq("router_key","local-test").eq("status","pending")
      .contains("queue_identity",{id:q.id});
    if (expireError) return "Service status was recorded, but the older queued router request could not be replaced. Check command history.";
    const {error} = await db.from("mikrotik_bandwidth_jobs").insert({
      organization_id:org,router_key:"local-test",requested_by:userId,
      subscriber_id:service.subscriber_id,service_id:service.id,
      required_status:service.status,required_plan_id:service.plan_id,
      queue_identity:identity,expected,desired,
    });
    if (error) {
      console.error("mikrotik_bandwidth_jobs insert failed:", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });

      return `Router queue failed: ${error.code ?? "unknown"} — ${error.message}`;
    }
    return service.status === "active"
      ? "Service recorded. Plan bandwidth is queued for the mapped router; check command history for confirmation."
      : "Service recorded. The 1k restriction is queued for the mapped router; check command history for confirmation.";
  } catch { return "Service status was recorded, but router synchronization failed. Check the mapping, migration and command history."; }
}
