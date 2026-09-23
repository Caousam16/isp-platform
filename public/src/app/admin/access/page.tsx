import { CredentialManager } from "@/components/credential-manager";
import { requireRole } from "@/lib/access";
import { readAll } from "@/lib/paged-read";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const { client, role } = await requireRole(["admin", "staff"]);
  const organizationsClient=client;
  const [organizationsResult, unlinkedResult, linkedResult] = await Promise.all([
    organizationsClient
      .from("organizations")
      .select("id, name")
      .order("name"),
    readAll((from,to)=>client.from("subscribers")
      .select("id, organization_id, account_number, name")
      .is("user_id", null)
      .neq("status", "suspended")
      .order("created_at", { ascending: false })
      .order("id").range(from,to)),
    readAll((from,to)=>client.from("subscribers")
      .select("id, organization_id, account_number, name")
      .not("user_id", "is", null)
      .neq("status", "suspended")
      .order("created_at", { ascending: false })
      .order("id").range(from,to)),
  ]);
  if (organizationsResult.error || unlinkedResult.error || linkedResult.error) {
    throw new Error("Unable to load subscriber access records.");
  }

  return (
    <CredentialManager
      role={role}
      organizations={organizationsResult.data ?? []}
      subscribers={unlinkedResult.data ?? []}
      linkedSubscribers={linkedResult.data ?? []}
      provisioningConfigured={Boolean(
        process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      )}
    />
  );
}
