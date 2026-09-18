import { Workspace } from "@/components/workspace";
import { requireRole } from "@/lib/access";
import type { Role, WorkspaceData } from "@/lib/domain";
import { createAdminClient } from "@/lib/supabase/admin";

export async function LiveWorkspace({ allowedRoles }: { allowedRoles: Role[] }) {
  const { client, role } = await requireRole(allowedRoles);
  let dataClient = client;
  if (role === "admin") {
    try {
      dataClient = createAdminClient();
    } catch {
      // Keep the authenticated client when privileged server credentials are
      // unavailable. RLS remains the fallback authorization boundary.
    }
  }
  const queries = await Promise.all([
    dataClient
      .from("organizations")
      .select("id, name, currency, address, tax_id, contact_email, contact_phone")
      .order("name"),
    dataClient
      .from("subscribers")
      .select("id, organization_id, account_number, name, email, phone, address, status")
      .order("created_at", { ascending: false })
      .limit(500),
    dataClient
      .from("plans")
      .select("id, organization_id, name, download_mbps, upload_mbps, price_minor, currency")
      .order("price_minor")
      .limit(100),
    dataClient
      .from("subscriber_services")
      .select("id, organization_id, subscriber_id, plan_id, status")
      .limit(500),
    dataClient
      .from("invoice_balances")
      .select(
        "id, organization_id, number, subscriber_id, issued_on, due_on, description, total_minor, paid_minor, currency",
      )
      .limit(500),
    dataClient
      .from("payments")
      .select("id, organization_id, subscriber_id, reference, receipt_number, payment_method, amount_minor, currency, received_at")
      .order("received_at", { ascending: false })
      .limit(500),
    dataClient
      .from("payment_allocations")
      .select("id, organization_id, invoice_id, payment_id, amount_minor")
      .limit(1000),
    role === "admin"
      ? dataClient
          .from("mikrotik_subscriber_queues")
          .select("subscriber_id, organization_id, queue_id, queue_name, target, ip_address, mac_address, dhcp_lease_id, dhcp_host_name, dhcp_status, network_seen_at")
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    role === "admin"
      ? dataClient
          .from("audit_events")
          .select("id, organization_id, action, entity_type, created_at")
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (queries.some((query) => query.error)) {
    throw new Error(
      "Unable to load workspace. Check database migrations and access policies.",
    );
  }

  const [
    organizationResult,
    subscribersResult,
    plansResult,
    servicesResult,
    invoicesResult,
    paymentsResult,
    allocationsResult,
    networkIdentityResult,
    auditResult,
  ] = queries;
  const data = {
    organizations: organizationResult.data ?? [],
    subscribers: subscribersResult.data ?? [],
    plans: plansResult.data ?? [],
    services: servicesResult.data ?? [],
    invoices: invoicesResult.data ?? [],
    payments: paymentsResult.data ?? [],
    allocations: allocationsResult.data ?? [],
    audit: auditResult.data ?? [],
    networkIdentities: networkIdentityResult.data ?? [],
  } as WorkspaceData;

  return (
    <Workspace
      initialData={data}
      initialRole={role}
      mode="live"
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
