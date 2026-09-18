import { CredentialManager } from "@/components/credential-manager";
import { requireRole } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const { client, role } = await requireRole(["admin", "staff"]);
  let organizationsClient = client;
  if (role === "admin") {
    try {
      organizationsClient = createAdminClient();
    } catch {
      // Credential provisioning will be disabled below; retain the RLS-scoped
      // client so the page can still explain the missing server configuration.
    }
  }
  const [organizationsResult, unlinkedResult, linkedResult] = await Promise.all([
    organizationsClient
      .from("organizations")
      .select("id, name")
      .order("name"),
    client
      .from("subscribers")
      .select("id, organization_id, account_number, name")
      .is("user_id", null)
      .neq("status", "suspended")
      .order("created_at", { ascending: false })
      .limit(500),
    client
      .from("subscribers")
      .select("id, organization_id, account_number, name")
      .not("user_id", "is", null)
      .neq("status", "suspended")
      .order("created_at", { ascending: false })
      .limit(500),
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
        process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
      )}
    />
  );
}
