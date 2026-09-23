import { Workspace } from "@/components/workspace";
import { requireRole } from "@/lib/access";
import type { Role, WorkspaceData } from "@/lib/domain";
import { readAll } from "@/lib/paged-read";

export async function LiveWorkspace({ allowedRoles }: { allowedRoles: Role[] }) {
  const { client, role } = await requireRole(allowedRoles);
  const dataClient = client;
  const queries = await Promise.all([
    dataClient
      .from("organizations")
      .select("id, name, currency, address, tax_id, contact_email, contact_phone")
      .order("name"),
    readAll((from,to)=>dataClient.from("subscribers")
      .select("id, organization_id, account_number, name, email, phone, address, status")
      .order("created_at", { ascending: false })
      .order("id").range(from,to)),
    readAll((from,to)=>dataClient.from("plans")
      .select("id, organization_id, name, download_mbps, upload_mbps, price_minor, currency")
      .order("price_minor")
      .order("id").range(from,to)),
    readAll((from,to)=>dataClient.from("subscriber_services")
      .select("id, organization_id, subscriber_id, plan_id, status")
      .order("id").range(from,to)),
    readAll((from,to)=>dataClient.from("invoice_balances")
      .select(
        "id, organization_id, number, subscriber_id, issued_on, due_on, description, total_minor, paid_minor, currency",
      )
      .order("id").range(from,to)),
    readAll((from,to)=>dataClient.from("payments")
      .select("id, organization_id, subscriber_id, reference, receipt_number, payment_method, amount_minor, currency, received_at")
      .order("received_at", { ascending: false })
      .order("id").range(from,to)),
    readAll((from,to)=>dataClient.from("payment_allocations")
      .select("id, organization_id, invoice_id, payment_id, amount_minor")
      .order("id").range(from,to)),
    role === "admin"
      ? readAll((from,to)=>dataClient.from("mikrotik_subscriber_queues")
          .select("subscriber_id, organization_id, router_key, queue_id, queue_name, target, ip_address, mac_address, dhcp_lease_id, dhcp_host_name, dhcp_status, network_seen_at")
          .order("subscriber_id").range(from,to))
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
  const { data: snapshots, error: snapshotError } =
  role === "admin"
    ? await client
        .from("mikrotik_snapshots")
        .select("organization_id,router_key,received_at")
    : { data: [], error: null };
  if (snapshotError) {
    console.error("Unable to load router freshness:", {
      message: snapshotError.message,
      code: snapshotError.code,
      details: snapshotError.details,
      hint: snapshotError.hint,
    });
  }
  const networkIdentities=(networkIdentityResult.data??[]).map(row=>{
    const snapshot=snapshots?.find(s=>s.organization_id===row.organization_id&&s.router_key===row.router_key);
    return {...row,network_seen_at:row.dhcp_status!=="unknown"&&snapshot?snapshot.received_at:row.network_seen_at};
  });
  const data = {
    organizations: organizationResult.data ?? [],
    subscribers: subscribersResult.data ?? [],
    plans: plansResult.data ?? [],
    services: servicesResult.data ?? [],
    invoices: invoicesResult.data ?? [],
    payments: paymentsResult.data ?? [],
    allocations: allocationsResult.data ?? [],
    audit: auditResult.data ?? [],
    networkIdentities,
  } as WorkspaceData;

  return (
    <Workspace
      initialData={data}
      initialRole={role}
      mode="live"
      today={new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Manila"}).format(new Date())}
    />
  );
}
