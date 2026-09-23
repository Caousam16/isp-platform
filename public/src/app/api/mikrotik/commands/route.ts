import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readJsonBounded } from "@/lib/mikrotik";
import { configuredRouters, authenticateRouter } from "@/lib/mikrotik-config";
export const runtime = "nodejs";
export const maxDuration = 30;
const resultSchema = z.object({
  action: z.literal("result"), id: z.uuid(), lease: z.uuid(),
  status: z.enum(["applied", "rejected", "uncertain"]),
  code: z.enum(["verified", "precondition_failed", "write_outcome_unknown", "interrupted"]),
}).strict().refine(value => (value.status === "applied" && value.code === "verified") ||
  (value.status === "rejected" && value.code === "precondition_failed") ||
  (value.status === "uncertain" && ["write_outcome_unknown", "interrupted"].includes(value.code)));
const requestSchema = z.union([z.object({ action: z.literal("claim") }).strict(), resultSchema]);
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  let scopes;try {scopes=configuredRouters();} catch{return reply(503,{message:"Connector not configured"});}
  if(!scopes.length)return reply(503,{message:"Connector not configured"});
  const scope=authenticateRouter(request.headers.get("authorization"),scopes);
  if(!scope)return reply(401,{message:"Unauthorized"});
  let input;
  try { input = requestSchema.parse(await readJsonBounded(request, 4096)); }
  catch { return reply(400, { message: "Invalid command request" }); }
  try {
    const db = createAdminClient();
    if (input.action === "claim") {
      const { data, error } = await db.rpc("claim_mikrotik_bandwidth_job", { p_org: scope.organizationId, p_router: scope.routerKey });
      if (error) return reply(503, { message: "Command storage unavailable" });
      return reply(200, { job: data?.[0] ?? null });
    }
    const { data, error } = await db.from("mikrotik_bandwidth_jobs").update({
      status: input.status, result_code: input.code, finished_at: new Date().toISOString(),
    }).eq("id", input.id).eq("organization_id", scope.organizationId).eq("router_key", scope.routerKey).eq("lease", input.lease)
      .in("status", ["running", "uncertain"]).select("id").maybeSingle();
    if (error) return reply(503, { message: "Result storage unavailable" });
    if (!data) {
      const { data: existing } = await db.from("mikrotik_bandwidth_jobs").select("status,result_code")
        .eq("id", input.id).eq("organization_id", scope.organizationId).eq("router_key", scope.routerKey).eq("lease", input.lease).maybeSingle();
      if (existing?.status !== input.status || existing?.result_code !== input.code)
        return reply(409, { message: "Command state conflict" });
    }
    return reply(200, { message: "Result recorded" });
  } catch { return reply(503, { message: "Command storage unavailable" }); }
}
