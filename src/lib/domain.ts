export type Role = "admin" | "staff" | "subscriber";
export type Subscriber = {
  id: string;
  organization_id: string;
  account_number: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  status: "active" | "suspended" | "pending";
};
export type Plan = {
  id: string;
  organization_id: string;
  name: string;
  download_mbps: number;
  upload_mbps: number;
  price_minor: number;
  currency: string;
};
export type ServiceStatus = "pending" | "active" | "suspended" | "terminated";
export type ServiceLifecycleAction =
  | "activate"
  | "suspend"
  | "reconnect"
  | "terminate"
  | "change_plan";
export type Service = {
  id: string;
  organization_id: string;
  subscriber_id: string;
  plan_id: string;
  status: ServiceStatus;
};
export type Invoice = {
  id: string;
  organization_id: string;
  number: string;
  subscriber_id: string;
  issued_on: string;
  due_on: string;
  description: string;
  total_minor: number;
  paid_minor: number;
  currency: string;
};
export type Organization = {
  id: string;
  name: string;
  currency: string;
  address: string;
  tax_id: string;
  contact_email: string;
  contact_phone: string;
};
export type Payment = {
  id: string;
  organization_id: string;
  subscriber_id: string;
  reference: string;
  receipt_number: string;
  payment_method: string;
  amount_minor: number;
  currency: string;
  received_at: string;
};
export type PaymentAllocation = {
  id: string;
  organization_id: string;
  invoice_id: string;
  payment_id: string;
  amount_minor: number;
};
export type Audit = {
  id: string;
  organization_id: string;
  action: string;
  entity_type: string;
  created_at: string;
};
export type NetworkIdentity = {
  subscriber_id: string;
  organization_id: string;
  queue_id: string | null;
  queue_name: string | null;
  target: string | null;
  ip_address: string;
  mac_address: string | null;
  dhcp_lease_id: string | null;
  dhcp_host_name: string | null;
  dhcp_status: string | null;
  network_seen_at: string | null;
};
export type WorkspaceData = {
  organizations: Organization[];
  subscribers: Subscriber[];
  plans: Plan[];
  services: Service[];
  invoices: Invoice[];
  payments: Payment[];
  allocations: PaymentAllocation[];
  audit: Audit[];
  networkIdentities: NetworkIdentity[];
};
const SUBSCRIBER_ACCOUNT_PATTERN = /^[A-Z0-9-]{3,30}$/;

export function subscriberLoginEmail(accountNumber: string): string {
  const normalized = accountNumber.trim().toUpperCase();
  if (!SUBSCRIBER_ACCOUNT_PATTERN.test(normalized)) {
    throw new Error("Use a valid account number.");
  }
  return normalized.toLowerCase() + "@accounts.southwoods.invalid";
}

export function balance(invoice: Invoice): number {
  return Math.max(0, invoice.total_minor - invoice.paid_minor);
}
export function invoiceStatus(
  invoice: Invoice,
  today: string,
): "paid" | "overdue" | "open" {
  if (balance(invoice) === 0) return "paid";
  return invoice.due_on < today ? "overdue" : "open";
}
export function money(amountMinor: number, currency = "PHP"): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
export function toMinorUnits(value: string): number {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value))
    throw new Error("Use a positive amount with up to two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function serviceLifecycleActions(
  status: ServiceStatus,
): ServiceLifecycleAction[] {
  if (status === "terminated") return [];
  const transition =
    status === "pending"
      ? "activate"
      : status === "active"
        ? "suspend"
        : "reconnect";
  return [transition, "change_plan", "terminate"];
}
