import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Service } from "@/lib/domain";
// Compatibility export. Lifecycle changes now enqueue inside their database transaction.
export async function queueServiceRouterSync(service:Service,_userId:string):Promise<string>{
 const client=await createClient();const {data,error}=await client.rpc("sync_subscriber_router",{p_subscriber:service.subscriber_id});
 return error?"Could not queue router synchronization. Check fresh identity and command history.":data?"Router synchronization queued; verify command history.":"No mapped service to synchronize.";
}
