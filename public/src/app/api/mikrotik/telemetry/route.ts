import { createAdminClient } from "@/lib/supabase/admin";
import { readTelemetry } from "@/lib/mikrotik";
import { configuredRouters, authenticateRouter } from "@/lib/mikrotik-config";
export const runtime = "nodejs";
export const maxDuration = 30;
const reply=(status:number,message:string)=>Response.json({message},{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request) {
 let scopes;try {scopes=configuredRouters();} catch{return reply(503,"Connector not configured");}
 if(!scopes.length)return reply(503,"Connector not configured");
 const scope=authenticateRouter(request.headers.get("authorization"),scopes);
 if(!scope)return reply(401,"Unauthorized");
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")return reply(415,"JSON required");
 let snapshot;try{snapshot=await readTelemetry(request);}catch{return reply(400,"Invalid or oversized snapshot");}
 const collectedAt=snapshot.collectedAt??new Date().toISOString();
 const age=Date.now()-Date.parse(collectedAt);
 if(age < -60_000 || age > 600_000)return reply(400,"Snapshot timestamp outside accepted window");
 try {
 const { error } = await createAdminClient().rpc(
  "ingest_mikrotik_snapshot",
  {
    p_org: scope.organizationId,
    p_router: scope.routerKey,
    p_snapshot: snapshot,
    p_collected_at: collectedAt,
  }
);

if (error) {
  console.error("ingest_mikrotik_snapshot failed:", {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  });

  return reply(503, "Snapshot storage unavailable");
}

return reply(200, "Snapshot received");

} catch (error) {
  console.error("Snapshot ingestion exception:", error);
  return reply(503, "Snapshot storage unavailable");
}
}
