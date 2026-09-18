"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CircleHelp,
  CreditCard,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Wifi,
  X,
} from "lucide-react";
import type {
  Audit,
  Invoice,
  Payment,
  PaymentAllocation,
  Plan,
  Role,
  Service,
  ServiceLifecycleAction,
  Subscriber,
  WorkspaceData,
} from "@/lib/domain";
import {
  balance,
  csvCell,
  invoiceStatus,
  money,
  serviceLifecycleActions,
  toMinorUnits,
} from "@/lib/domain";
import {
  assignPlan,
  changeSubscriberPassword,
  createInvoice,
  createSubscriber,
  createPlan,
  manageService,
  postPayment,
  updateSubscriberContact,
} from "@/app/workspace/actions";
import { createClient } from "@/lib/supabase/client";
import { downloadInvoicePdf, downloadReceiptPdf } from "@/lib/billing-pdf";

type View =
  | "overview"
  | "subscribers"
  | "plans"
  | "services"
  | "billing"
  | "account"
  | "reports"
  | "audit";
type BillingTab = "dashboard" | "invoices" | "payments";
type BillingPeriod = "current-month" | "previous-month" | "month" | "custom" | "all";
type ServiceActionModal = {
  kind: "service-action";
  action: ServiceLifecycleAction;
  service: Service;
};
type Modal =
  | "subscriber"
  | "plan"
  | "assignment"
  | "invoice"
  | "payment"
  | Invoice
  | Payment
  | Subscriber
  | ServiceActionModal
  | null;
const serviceActionLabels: Record<ServiceLifecycleAction, string> = {
  activate: "Activate",
  suspend: "Suspend",
  reconnect: "Reconnect",
  terminate: "Terminate",
  change_plan: "Change plan",
};
const serviceActionCompleted: Record<ServiceLifecycleAction, string> = {
  activate: "activated",
  suspend: "suspended",
  reconnect: "reconnected",
  terminate: "terminated",
  change_plan: "moved to the new plan",
};
const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "subscribers", label: "Subscribers", icon: Users },
  { id: "plans", label: "Internet plans", icon: Wifi },
  { id: "services", label: "Services", icon: Network },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "account", label: "My account", icon: UserRound },
  { id: "reports", label: "Reports", icon: Activity },
  { id: "audit", label: "Audit log", icon: ShieldCheck },
] as const;
function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthBounds(month: string): { from: string; to: string } {
  const nextMonth = shiftMonth(month, 1);
  const lastDay = new Date(`${nextMonth}-01T00:00:00Z`);
  lastDay.setUTCDate(0);
  return { from: `${month}-01`, to: lastDay.toISOString().slice(0, 10) };
}
function inDateRange(date: string, from?: string, to?: string): boolean {
  const day = date.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}
function compactDate(date: string): string {
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date.slice(0, 10)}T00:00:00Z`),
  );
}
function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value}</span>;
}
function Dialog({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Workspace({
  initialData,
  initialRole,
  mode,
  today,
}: {
  initialData: WorkspaceData;
  initialRole: Role;
  mode: "live" | "demo";
  today: string;
}) {
  const [data, setData] = useState(initialData);
  const [role, setRole] = useState<Role>(initialRole);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(
    initialRole === "admin" ? "all" : (initialData.organizations[0]?.id ?? "all"),
  );
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [speedFilter, setSpeedFilter] = useState("all");
  const [paymentMethodFilter, setPaymentMethodFilter] = useState("all");
  const [auditEntityFilter, setAuditEntityFilter] = useState("all");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [billingTab, setBillingTab] = useState<BillingTab>(
    initialRole === "subscriber" ? "invoices" : "dashboard",
  );
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("current-month");
  const [billingMonth, setBillingMonth] = useState(today.slice(0, 7));
  const [billingFrom, setBillingFrom] = useState(`${today.slice(0, 7)}-01`);
  const [billingTo, setBillingTo] = useState(today);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const portal = role === "subscriber";
  const isDemo = mode === "demo";
  const activeOrganization =
    data.organizations.find((organization) => organization.id === selectedOrganizationId) ??
    data.organizations[0];
  const companyData =
    selectedOrganizationId === "all"
      ? data
      : {
          ...data,
          subscribers: data.subscribers.filter((item) => item.organization_id === selectedOrganizationId),
          plans: data.plans.filter((item) => item.organization_id === selectedOrganizationId),
          services: data.services.filter((item) => item.organization_id === selectedOrganizationId),
          invoices: data.invoices.filter((item) => item.organization_id === selectedOrganizationId),
          payments: data.payments.filter((item) => item.organization_id === selectedOrganizationId),
          allocations: data.allocations.filter((item) => item.organization_id === selectedOrganizationId),
          audit: data.audit.filter((item) => item.organization_id === selectedOrganizationId),
          networkIdentities: data.networkIdentities.filter((item) => item.organization_id === selectedOrganizationId),
        };
  const visible =
    portal && isDemo
      ? {
          ...companyData,
          subscribers: companyData.subscribers.filter((s) => s.id === "s1"),
          services: companyData.services.filter((s) => s.subscriber_id === "s1"),
          invoices: companyData.invoices.filter((i) => i.subscriber_id === "s1"),
          payments: companyData.payments.filter((p) => p.subscriber_id === "s1"),
          allocations: companyData.allocations.filter((a) =>
            companyData.invoices.some((i) => i.id === a.invoice_id && i.subscriber_id === "s1")),
        }
      : companyData;
  const due = visible.invoices.filter(
    (i) => invoiceStatus(i, today) === "overdue",
  );
  const outstanding = visible.invoices.reduce((sum, i) => sum + balance(i), 0);
  const collected = visible.invoices.reduce((sum, i) => sum + i.paid_minor, 0);
  const billed = visible.invoices.reduce((sum, i) => sum + i.total_minor, 0);
  const currency =
    visible.invoices[0]?.currency ?? visible.plans[0]?.currency ?? "PHP";
  const active = visible.subscribers.filter(
    (s) => s.status === "active",
  ).length;
  const planFor = (id: string) =>
    visible.plans.find(
      (p) =>
        p.id === visible.services.find((s) => s.subscriber_id === id)?.plan_id,
    );
  const subscriberFor = (id: string) =>
    visible.subscribers.find((s) => s.id === id);
  const organizationFor = (id: string) =>
    data.organizations.find((organization) => organization.id === id) ?? activeOrganization;
  const unassignedSubscribers = visible.subscribers.filter(
    (subscriber) =>
      !visible.services.some(
        (service) =>
          service.subscriber_id === subscriber.id &&
          service.status !== "terminated",
      ),
  );
  const normalizedQuery = query.trim().toLowerCase();
  const matchingSubscribers = visible.subscribers.filter((subscriber) => {
    const plan = planFor(subscriber.id);
    const organization = organizationFor(subscriber.organization_id);
    const haystack = `${subscriber.name} ${subscriber.account_number} ${subscriber.email} ${subscriber.phone} ${subscriber.address} ${subscriber.status} ${plan?.name ?? "unassigned"} ${organization?.name ?? ""}`;
    return haystack.toLowerCase().includes(normalizedQuery) &&
      (filter === "all" || subscriber.status === filter) &&
      (planFilter === "all" || (planFilter === "unassigned" ? !plan : plan?.id === planFilter));
  });
  const matchingPlans = visible.plans.filter((plan) => {
    const organization = organizationFor(plan.organization_id);
    const haystack = `${plan.name} ${plan.download_mbps} ${plan.upload_mbps} ${money(plan.price_minor, plan.currency)} ${organization?.name ?? ""}`;
    const matchesSpeed =
      speedFilter === "all" ||
      (speedFilter === "up-to-100" && plan.download_mbps <= 100) ||
      (speedFilter === "101-500" && plan.download_mbps > 100 && plan.download_mbps <= 500) ||
      (speedFilter === "501-plus" && plan.download_mbps > 500);
    return haystack.toLowerCase().includes(normalizedQuery) && matchesSpeed;
  });
  const currentMonth = today.slice(0, 7);
  const selectedMonth =
    billingPeriod === "previous-month"
      ? shiftMonth(currentMonth, -1)
      : billingPeriod === "month"
        ? billingMonth
        : currentMonth;
  const selectedMonthBounds = monthBounds(selectedMonth);
  const billingRange =
    billingPeriod === "all"
      ? {}
      : billingPeriod === "custom"
        ? { from: billingFrom || undefined, to: billingTo || undefined }
        : selectedMonthBounds;
  const periodInvoices = visible.invoices.filter((invoice) =>
    inDateRange(invoice.issued_on, billingRange.from, billingRange.to),
  );
  const periodPayments = visible.payments.filter((payment) =>
    inDateRange(payment.received_at, billingRange.from, billingRange.to),
  );
  const matchingInvoices = visible.invoices.filter(
    (i) =>
      inDateRange(i.issued_on, billingRange.from, billingRange.to) &&
      `${i.number} ${i.description} ${i.issued_on} ${i.due_on} ${i.total_minor} ${subscriberFor(i.subscriber_id)?.name ?? ""} ${subscriberFor(i.subscriber_id)?.account_number ?? ""} ${organizationFor(i.organization_id)?.name ?? ""} ${invoiceStatus(i, today)}`
        .toLowerCase()
        .includes(normalizedQuery) &&
      (filter === "all" || invoiceStatus(i, today) === filter),
  );
  const matchingServices = visible.services.filter((service) => {
    const subscriber = subscriberFor(service.subscriber_id);
    const plan = visible.plans.find((item) => item.id === service.plan_id);
    const haystack = `${subscriber?.name ?? ""} ${subscriber?.account_number ?? ""} ${plan?.name ?? ""} ${service.status}`;
    return `${haystack} ${subscriber?.email ?? ""} ${subscriber?.phone ?? ""} ${subscriber?.address ?? ""} ${organizationFor(service.organization_id)?.name ?? ""}`
      .toLowerCase().includes(normalizedQuery) &&
      (filter === "all" || service.status === filter) &&
      (planFilter === "all" || service.plan_id === planFilter);
  });
  const matchingPayments = visible.payments.filter((payment) => {
    const subscriber = subscriberFor(payment.subscriber_id);
    const allocation = visible.allocations.find((item) => item.payment_id === payment.id);
    const invoice = visible.invoices.find((item) => item.id === allocation?.invoice_id);
    return inDateRange(payment.received_at, billingRange.from, billingRange.to) &&
      `${payment.receipt_number} ${payment.reference} ${payment.payment_method} ${payment.received_at} ${payment.amount_minor} ${subscriber?.name ?? ""} ${subscriber?.account_number ?? ""} ${invoice?.number ?? ""} ${organizationFor(payment.organization_id)?.name ?? ""}`
      .toLowerCase().includes(normalizedQuery) &&
      (paymentMethodFilter === "all" || payment.payment_method === paymentMethodFilter);
  });
  const matchingAudit = visible.audit.filter((event) => {
    const createdDate = event.created_at.slice(0, 10);
    const haystack = `${event.action} ${event.entity_type} ${event.created_at} ${organizationFor(event.organization_id)?.name ?? ""}`;
    return haystack.toLowerCase().includes(normalizedQuery) &&
      (auditEntityFilter === "all" || event.entity_type === auditEntityFilter) &&
      (!auditFrom || createdDate >= auditFrom) &&
      (!auditTo || createdDate <= auditTo);
  });
  const periodBilled = periodInvoices.reduce((sum, invoice) => sum + invoice.total_minor, 0);
  const periodCollected = periodPayments.reduce((sum, payment) => sum + payment.amount_minor, 0);
  const periodOutstanding = periodInvoices.reduce((sum, invoice) => sum + balance(invoice), 0);
  const periodOverdue = periodInvoices.filter((invoice) => invoiceStatus(invoice, today) === "overdue");
  const collectionRate = periodBilled
    ? Math.round((periodCollected / periodBilled) * 100)
    : 0;
  const activityByDate = Array.from(
    new Set([
      ...periodInvoices.map((invoice) => invoice.issued_on),
      ...periodPayments.map((payment) => payment.received_at.slice(0, 10)),
    ]),
  )
    .sort()
    .slice(-8)
    .map((date) => ({
      date,
      billed: periodInvoices
        .filter((invoice) => invoice.issued_on === date)
        .reduce((sum, invoice) => sum + invoice.total_minor, 0),
      collected: periodPayments
        .filter((payment) => payment.received_at.slice(0, 10) === date)
        .reduce((sum, payment) => sum + payment.amount_minor, 0),
    }));
  const activityPeak = Math.max(
    1,
    ...activityByDate.flatMap((item) => [item.billed, item.collected]),
  );
  const outstandingAccounts = Array.from(
    periodInvoices.reduce((accounts, invoice) => {
      const amount = balance(invoice);
      if (!amount) return accounts;
      accounts.set(invoice.subscriber_id, (accounts.get(invoice.subscriber_id) ?? 0) + amount);
      return accounts;
    }, new Map<string, number>()),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const periodLabel =
    billingPeriod === "all"
      ? "All loaded records"
      : billingPeriod === "custom"
        ? billingFrom && billingTo
          ? `${compactDate(billingFrom)} – ${compactDate(billingTo)}`
          : "Custom date range"
        : new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(
            new Date(`${selectedMonth}-01T00:00:00Z`),
          );
  const hasSearchFilters = Boolean(
    query || filter !== "all" || planFilter !== "all" || speedFilter !== "all" ||
    paymentMethodFilter !== "all" || auditEntityFilter !== "all" || auditFrom || auditTo ||
    billingPeriod !== "current-month",
  );
  function clearSearchFilters() {
    setQuery("");
    setFilter("all");
    setPlanFilter("all");
    setSpeedFilter("all");
    setPaymentMethodFilter("all");
    setAuditEntityFilter("all");
    setAuditFrom("");
    setAuditTo("");
    setBillingPeriod("current-month");
    setBillingMonth(currentMonth);
    setBillingFrom(`${currentMonth}-01`);
    setBillingTo(today);
  }
  function navigate(next: View) {
    setView(next);
    clearSearchFilters();
    if (next === "billing") setBillingTab(portal ? "invoices" : "dashboard");
  }
  function openModal(next: Modal) {
    setError("");
    setModal(next);
  }
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setData(initialData);
  }, [initialData]);
  // Progressive enhancement: only expose a read/search tool, and only for the public demo.
  useEffect(() => {
    type Context = {
      registerTool: (
        tool: object,
        options: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
    const context = (document as Document & { modelContext?: Context })
      .modelContext;
    if (!isDemo || portal || !context) return;
    const abort = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "search_demo_subscribers",
            description:
              "Filter the synthetic demo subscriber list by name or account number. Does not access live records.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string", maxLength: 100 } },
              required: ["query"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            execute(input: unknown) {
              if (
                !input ||
                typeof input !== "object" ||
                !("query" in input) ||
                typeof input.query !== "string" ||
                input.query.length > 100
              )
                throw new Error(
                  "A query string of at most 100 characters is required.",
                );
              const text = input.query;
              navigate("subscribers");
              setQuery(text);
              return {
                matches: data.subscribers
                  .filter((s) =>
                    `${s.name} ${s.account_number} ${s.email}`
                      .toLowerCase()
                      .includes(text.toLowerCase()),
                  )
                  .map((s) => ({
                    account_number: s.account_number,
                    name: s.name,
                  })),
              };
            },
          },
          { signal: abort.signal },
        ),
      ).catch(() => {});
    } catch {
      /* Optional browser capability. */
    }
    return () => abort.abort();
  }, [isDemo, portal, data.subscribers]);
  function exportCsv() {
    const rows =
      view === "billing" && billingTab !== "payments"
        ? [
            [
              "Invoice",
              "Company",
              "Subscriber",
              "Due date",
              "Total minor units",
              "Paid minor units",
              "Currency",
            ],
            ...matchingInvoices.map((i) => [
              i.number,
              organizationFor(i.organization_id)?.name ?? "",
              subscriberFor(i.subscriber_id)?.name ?? "",
              i.due_on,
              i.total_minor,
              i.paid_minor,
              i.currency,
            ]),
          ]
        : view === "billing"
          ? [
              ["Receipt", "Company", "Subscriber", "Received", "Method", "Reference", "Amount minor units", "Currency"],
              ...matchingPayments.map((payment) => [
                payment.receipt_number,
                organizationFor(payment.organization_id)?.name ?? "",
                subscriberFor(payment.subscriber_id)?.name ?? "",
                payment.received_at,
                payment.payment_method,
                payment.reference,
                payment.amount_minor,
                payment.currency,
              ]),
            ]
          : [
            ["Account", "Company", "Name", "Email", "Address", "Status"],
            ...matchingSubscribers.map((s) => [
              s.account_number,
              organizationFor(s.organization_id)?.name ?? "",
              s.name,
              s.email,
              s.address,
              s.status,
            ]),
          ];
    const blob = new Blob(
      [rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8;" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `southwoods-${view}-${isDemo ? "sample" : "export"}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function audit(action: string, type: string, organizationId = activeOrganization?.id ?? ""): Audit {
    return {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      action,
      entity_type: type,
      created_at: new Date().toISOString(),
    };
  }
  async function saveSubscriber(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = {
      organization_id: String(form.get("organization_id") || activeOrganization?.id || ""),
      name: String(form.get("name")).trim(),
      email: String(form.get("email")).trim(),
      phone: String(form.get("phone") ?? "").trim(),
      address: String(form.get("address")).trim(),
      account_number: String(form.get("account_number")).trim().toUpperCase(),
    };
    try {
      if (
        isDemo &&
        data.subscribers.some((s) => s.account_number === input.account_number)
      ) {
        setError("That account number is already in use.");
        return;
      }
      const result = isDemo
        ? {
            data: {
              ...input,
              id: crypto.randomUUID(),
              status: "pending" as const,
            },
          }
        : await createSubscriber(input);
      if ("error" in result) {
        setError(result.error ?? "Could not save.");
        return;
      }
      setData((d) => ({
        ...d,
        subscribers: [result.data as Subscriber, ...d.subscribers],
        audit: isDemo
          ? [audit("subscribers.created", "subscribers", result.data.organization_id), ...d.audit]
          : d.audit,
      }));
      setModal(null);
      navigate("subscribers");
      setToast(
        isDemo
          ? "Sample subscriber added. Changes reset on refresh."
          : "Subscriber created.",
      );
    } catch {
      setError("Could not save the subscriber. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function savePlan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = {
      organization_id: String(form.get("organization_id") || activeOrganization?.id || ""),
      name: String(form.get("name")),
      price: String(form.get("price")),
      download_mbps: Number(form.get("download_mbps")),
      upload_mbps: Number(form.get("upload_mbps")),
    };
    try {
      const result = isDemo
        ? {
            data: {
              id: crypto.randomUUID(),
              organization_id: input.organization_id,
              name: input.name,
              download_mbps: input.download_mbps,
              upload_mbps: input.upload_mbps,
              price_minor: toMinorUnits(input.price),
              currency,
            },
          }
        : await createPlan(input);
      if ("error" in result) {
        setError(result.error ?? "Could not save.");
        return;
      }
      setData((d) => ({
        ...d,
        plans: [...d.plans, result.data as Plan],
        audit: isDemo ? [audit("plans.created", "plans", result.data.organization_id), ...d.audit] : d.audit,
      }));
      setModal(null);
      setToast(
        isDemo
          ? "Sample plan added. Changes reset on refresh."
          : "Plan created.",
      );
    } catch {
      setError("Could not save. Check the price and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveAssignment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = {
      subscriber_id: String(form.get("subscriber_id")),
      plan_id: String(form.get("plan_id")),
    };
    const assignmentOrganizationId = data.subscribers.find((item) => item.id === input.subscriber_id)?.organization_id ?? "";
    try {
      const result = isDemo
        ? {
            data: {
              id: crypto.randomUUID(),
              organization_id: assignmentOrganizationId,
              subscriber_id: input.subscriber_id,
              plan_id: input.plan_id,
              status: "pending",
            },
          }
        : await assignPlan(input);
      if ("error" in result) {
        setError(result.error ?? "Could not assign the plan.");
        return;
      }
      setData((current) => ({
        ...current,
        services: [result.data as Service, ...current.services],
        audit: isDemo
          ? [
              audit("subscriber_services.created", "subscriber_services", assignmentOrganizationId),
              ...current.audit,
            ]
          : current.audit,
      }));
      setModal(null);
      navigate("services");
      setToast(
        isDemo
          ? "Sample plan assigned. Changes reset on refresh."
          : "Plan assigned with pending service status.",
      );
    } catch {
      setError("Could not assign the plan. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveServiceAction(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal || typeof modal === "string" || !("kind" in modal)) return;
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const planId =
      modal.action === "change_plan" ? String(form.get("plan_id")) : null;

    try {
      const nextStatus =
        modal.action === "activate" || modal.action === "reconnect"
          ? "active"
          : modal.action === "suspend"
            ? "suspended"
            : modal.action === "terminate"
              ? "terminated"
              : modal.service.status;
      const result = isDemo
        ? {
            data: {
              ...modal.service,
              status: nextStatus,
              plan_id: planId ?? modal.service.plan_id,
            } as Service,
          }
        : await manageService({
            service_id: modal.service.id,
            action: modal.action,
            plan_id: planId,
          });

      if ("error" in result) {
        setError(result.error ?? "Could not update the service.");
        return;
      }

      setData((current) => ({
        ...current,
        services: current.services.map((service) =>
          service.id === result.data.id ? result.data : service,
        ),
        audit: [
          audit(
            `subscriber_service.${modal.action}`,
            "subscriber_service",
            modal.service.organization_id,
          ),
          ...current.audit,
        ],
      }));
      setModal(null);
      setToast(
        isDemo
          ? `Sample service ${serviceActionCompleted[modal.action]}. Changes reset on refresh.`
          : `Service ${serviceActionCompleted[modal.action]}. ${"routerNotice" in result ? result.routerNotice : ""}`,
      );
    } catch {
      setError("Could not update the service. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const subscriber = visible.subscribers[0];
    if (!subscriber) return;
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = {
      email: String(form.get("email")).trim(),
      phone: String(form.get("phone")).trim(),
      address: String(form.get("address")).trim(),
    };
    try {
      const result = isDemo ? { data: { ...subscriber, ...input } } : await updateSubscriberContact(input);
      if ("error" in result) { setError(result.error ?? "Could not update your contact information."); return; }
      setData((current) => ({ ...current, subscribers: current.subscribers.map((item) => item.id === result.data.id ? result.data : item) }));
      setToast(isDemo ? "Sample contact information updated for this session." : "Contact information updated.");
    } catch { setError("Could not update your contact information."); }
    finally { setBusy(false); }
  }
  async function savePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = { password: String(form.get("password")), confirm_password: String(form.get("confirm_password")) };
    try {
      const result = isDemo ? (input.password.length >= 12 && input.password === input.confirm_password ? { success: true as const } : { error: "Use a matching password of at least 12 characters." }) : await changeSubscriberPassword(input);
      if ("error" in result) { setError(result.error ?? "Could not change your password."); return; }
      e.currentTarget.reset();
      setToast(isDemo ? "Sample password form validated. No credentials were changed." : "Password changed successfully.");
    } catch { setError("Could not change your password."); }
    finally { setBusy(false); }
  }
  async function saveInvoice(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = {
      subscriber_id: String(form.get("subscriber_id")), issued_on: String(form.get("issued_on")),
      due_on: String(form.get("due_on")), description: String(form.get("description")).trim(), total: String(form.get("total")),
    };
    try {
      const invoiceOrganizationId = data.subscribers.find((item) => item.id === input.subscriber_id)?.organization_id ?? "";
      const result = isDemo ? { data: { id: crypto.randomUUID(), organization_id: invoiceOrganizationId, number: `INV-DEMO-${String(data.invoices.length + 1).padStart(4, "0")}`, subscriber_id: input.subscriber_id, issued_on: input.issued_on, due_on: input.due_on, description: input.description, total_minor: toMinorUnits(input.total), paid_minor: 0, currency } as Invoice } : await createInvoice(input);
      if ("error" in result) { setError(result.error ?? "Could not generate the invoice."); return; }
      setData((current) => ({ ...current, invoices: [result.data, ...current.invoices] }));
      setModal(null);
      setBillingTab("invoices");
      setToast(isDemo ? "Sample invoice generated for this session." : `Invoice ${result.data.number} generated.`);
    } catch { setError("Could not generate the invoice. Check the dates and total."); }
    finally { setBusy(false); }
  }
  async function savePayment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const input = { invoice_id: String(form.get("invoice_id")), amount: String(form.get("amount")), payment_method: String(form.get("payment_method")), reference: String(form.get("reference")).trim() };
    try {
      const invoice = data.invoices.find((item) => item.id === input.invoice_id);
      if (!invoice) { setError("Choose an invoice."); return; }
      const amountMinor = toMinorUnits(input.amount);
      if (amountMinor > balance(invoice)) { setError("Payment exceeds the invoice balance."); return; }
      const result = isDemo ? { data: { payment: { id: crypto.randomUUID(), organization_id: invoice.organization_id, subscriber_id: invoice.subscriber_id, reference: input.reference, receipt_number: `OR-DEMO-${String(data.payments.length + 1).padStart(4, "0")}`, payment_method: input.payment_method, amount_minor: amountMinor, currency: invoice.currency, received_at: new Date().toISOString() } as Payment, allocation: { id: crypto.randomUUID(), organization_id: invoice.organization_id, invoice_id: invoice.id, payment_id: "", amount_minor: amountMinor } as PaymentAllocation } } : await postPayment(input);
      if ("error" in result) { setError(result.error ?? "Could not post the payment."); return; }
      const payment = result.data.payment;
      const allocation = { ...result.data.allocation, payment_id: result.data.allocation.payment_id || payment.id };
      setData((current) => ({
        ...current, payments: [payment, ...current.payments], allocations: [allocation, ...current.allocations],
        invoices: current.invoices.map((item) => item.id === allocation.invoice_id ? { ...item, paid_minor: item.paid_minor + allocation.amount_minor } : item),
      }));
      setModal(null);
      setBillingTab("payments");
      setToast(isDemo ? "Sample payment posted for this session." : `Payment posted. Receipt ${payment.receipt_number} is ready.`);
    } catch { setError("Could not post the payment. Check the amount and reference."); }
    finally { setBusy(false); }
  }
  const title = portal
    ? view === "overview"
      ? "Your connection, at a glance."
      : view === "billing"
        ? "Your invoices"
        : view === "account"
          ? "Your account"
          : "Your service"
    : (navigation.find((n) => n.id === view)?.label ?? "Overview");
  const showCompany = role === "admin" && selectedOrganizationId === "all";
  function invoiceTable(invoices: Invoice[]) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              {showCompany && <th>Company</th>}
              {!portal && <th>Subscriber</th>}
              <th>Due date</th>
              <th>Balance</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Open invoice</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>
                  <button className="table-link" onClick={() => openModal(i)}>
                    {i.number}
                  </button>
                </td>
                {showCompany && <td>{organizationFor(i.organization_id)?.name}</td>}
                {!portal && (
                  <td>
                    {subscriberFor(i.subscriber_id)?.name ??
                      "Subscriber outside loaded page"}
                  </td>
                )}
                <td>{i.due_on}</td>
                <td className="numeric">{money(balance(i), i.currency)}</td>
                <td>
                  <Status value={invoiceStatus(i, today)} />
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`View ${i.number}`}
                    onClick={() => openModal(i)}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!invoices.length && (
          <p className="empty">No invoices match this view.</p>
        )}
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          SOUTHWOODS<span>CABLE AND INTERNET</span>
        </a>
        <div className="organization">
          <span className="org-icon">
            <Network size={19} />
          </span>
          <div>
            {selectedOrganizationId === "all"
              ? "All Southwoods companies"
              : (activeOrganization?.name ?? "Southwoods")}
            <small>
              {portal ? "Subscriber portal" : selectedOrganizationId === "all" ? "Admin group view" : "Coverage workspace"}
            </small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {navigation
            .filter((n) =>
              portal
                ? ["overview", "services", "billing", "account"].includes(n.id)
                : n.id !== "account" && (role === "admin" || n.id !== "audit"),
            )
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "selected" : ""}`}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <item.icon size={19} />
                {item.label}
                {item.id === "billing" && due.length > 0 && (
                  <span className="nav-count">{due.length}</span>
                )}
              </button>
            ))}
        </nav>
        {!isDemo && !portal && (
          <a href="/admin/access" className="nav-item">
            <KeyRound size={19} />
            Account credentials
          </a>
        )}
        {!isDemo && !portal && role === "admin" && (
          <a href="/admin/routers" className="nav-item">MikroTik connection test</a>
        )}
        <div className="sidebar-bottom">
          <div className="foundation">
            <ShieldCheck size={20} />
            <span>
              {isDemo ? "Sample environment" : "Authenticated workspace"}
              <small>
                {isDemo ? "No live customer records" : "Access enforced by RLS"}
              </small>
            </span>
          </div>
          <a
            href={!isDemo && !portal ? "/operations/sign-in" : "/login"}
            className="nav-item"
          >
            <CircleHelp size={19} />
            {isDemo ? "Connect your workspace" : "Account sign-in"}
          </a>
          <div className="user-card">
            <span className="avatar">{portal ? "AR" : "OP"}</span>
            <span>
              {portal
                ? (visible.subscribers[0]?.name ?? "Subscriber")
                : "Operations team"}
              <small>{role}</small>
            </span>
            {!isDemo && (
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  try {
                    const { error } = await createClient().auth.signOut();
                    if (error) throw error;
                    window.location.assign(
                      portal ? "/login" : "/operations/sign-in",
                    );
                  } catch {
                    setToast("Sign-out failed. Please retry.");
                  }
                }}
              >
                <LogOut size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>
              {portal
                ? "Subscriber portal"
                : navigation.find((n) => n.id === view)?.label}
            </strong>
          </div>
          <div className="topbar-right">
            {role === "admin" && data.organizations.length > 1 && (
              <label className="company-switch">
                Company
                <select
                  value={selectedOrganizationId}
                  onChange={(e) => {
                    setSelectedOrganizationId(e.target.value);
                    clearSearchFilters();
                    setModal(null);
                  }}
                >
                  <option value="all">All companies</option>
                  {data.organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>{organization.name}</option>
                  ))}
                </select>
              </label>
            )}
            {isDemo && (
              <label className="role-switch">
                Preview as
                <select
                  value={role}
                  onChange={(e) => {
                    const nextRole = e.target.value as Role;
                    setRole(nextRole);
                    setSelectedOrganizationId(
                      nextRole === "admin" ? "all" : (data.organizations[0]?.id ?? "all"),
                    );
                    navigate("overview");
                    setModal(null);
                  }}
                >
                  <option value="admin">Admin</option>
                  <option value="staff">Staff</option>
                  <option value="subscriber">Subscriber</option>
                </select>
              </label>
            )}
            <span className="date-label">{today}</span>
          </div>
        </header>
        <main id="main-content">
          <div className="demo-notice">
            <span className="notice-dot" />
            {isDemo ? "DEMO WORKSPACE" : "FOUNDATION RELEASE"}
            <span>
              {isDemo
                ? "Synthetic data · Changes last until you refresh · PHP sample currency"
                : "Live Supabase data · First 500 records · Advanced billing workflows not enabled"}
            </span>
            {isDemo && (
              <a href="/login">
                Set up live access <ArrowUpRight size={14} />
              </a>
            )}
          </div>
          <section className="page-heading">
            <div>
              <p className="eyebrow">
                {portal ? "MY ACCOUNT" : "YOUR OPERATIONS, CONNECTED"}
              </p>
              <h1>{title}</h1>
              <p>
                {portal
                  ? "Your plan, account balance and invoices in one place."
                  : view === "overview"
                    ? "A clear view of subscribers, services and collections."
                    : view === "subscribers"
                      ? "Manage the people and businesses you keep connected."
                      : view === "plans"
                        ? "Your fiber portfolio, built for every kind of connection."
                        : view === "billing"
                          ? "Track issued invoices, collections and outstanding balances."
                          : view === "services"
                            ? "Subscriber-to-plan assignments and recorded service states."
                            : view === "reports"
                              ? "Summaries of the records loaded in this workspace."
                              : "A record of sensitive changes in your workspace."}
              </p>
            </div>
            <div className="heading-actions">
              {!portal && ["subscribers", "billing"].includes(view) && (
                <button className="secondary" onClick={exportCsv}>
                  <ArrowDownToLine size={16} />
                  Export CSV
                </button>
              )}
              {!portal && ["overview", "subscribers"].includes(view) && (
                <button onClick={() => openModal("subscriber")}>
                  <Plus size={17} />
                  Add subscriber
                </button>
              )}
              {view === "plans" && role === "admin" && (
                <button onClick={() => openModal("plan")}>
                  <Plus size={17} />
                  Create plan
                </button>
              )}
              {view === "services" && !portal && (
                <button
                  onClick={() => openModal("assignment")}
                  disabled={!unassignedSubscribers.length || !visible.plans.length}
                >
                  <Plus size={17} />
                  Assign plan
                </button>
              )}
            </div>
          </section>
          {view === "overview" && (
            <>
              <section className="stats-grid">
                <article className="stat">
                  <div className="stat-label">
                    {portal ? "Current balance" : "Total subscribers"}
                    {portal ? <CreditCard size={19} /> : <Users size={19} />}
                  </div>
                  <strong>
                    {portal
                      ? money(outstanding, currency)
                      : visible.subscribers.length}
                  </strong>
                  <p>
                    {portal
                      ? "Across your unpaid invoices"
                      : `${active} active · ${visible.subscribers.filter((s) => s.status === "pending").length} pending activation`}
                  </p>
                </article>
                <article className="stat">
                  <div className="stat-label">
                    {portal ? "Your plan" : "Active services"}
                    <Wifi size={19} />
                  </div>
                  <strong>
                    {portal
                      ? (planFor(visible.subscribers[0]?.id)?.name ??
                        "Not assigned")
                      : visible.services.filter((s) => s.status === "active")
                          .length}
                  </strong>
                  <p>
                    {portal
                      ? `${planFor(visible.subscribers[0]?.id)?.download_mbps ?? 0} Mbps download`
                      : "Recorded service status, not live telemetry"}
                  </p>
                </article>
                <article className="stat">
                  <div className="stat-label">
                    {portal ? "Paid toward invoices" : "Collected on invoices"}
                    <CreditCard size={19} />
                  </div>
                  <strong>{money(collected, currency)}</strong>
                  <p>Allocated payments in this view</p>
                </article>
                <article className="stat attention-stat">
                  <div className="stat-label">
                    Overdue invoices
                    <FileText size={19} />
                  </div>
                  <strong>
                    {due.length}
                    <span>
                      {money(
                        due.reduce((sum, i) => sum + balance(i), 0),
                        currency,
                      )}
                    </span>
                  </strong>
                  <p>
                    {due.length
                      ? "Payment follow-up needed"
                      : "No overdue invoices"}
                  </p>
                </article>
              </section>
              <div className="overview-grid">
                <section className="panel collection-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">COLLECTIONS</p>
                      <h2>Every payment accounted for.</h2>
                    </div>
                    <span className="subtle-chip">Loaded invoices</span>
                  </div>
                  <div className="collection-total">
                    {money(collected, currency)}
                    <span>of {money(billed, currency)} billed</span>
                  </div>
                  <div
                    className="collection-meter"
                    role="meter"
                    aria-label="Invoice collection percentage"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      billed ? Math.round((collected / billed) * 100) : 0
                    }
                  >
                    <span
                      style={{
                        width: `${billed ? Math.min(100, (collected / billed) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="collection-legend">
                    <span>
                      <i />
                      Collected{" "}
                      <b>
                        {billed ? Math.round((collected / billed) * 100) : 0}%
                      </b>
                    </span>
                    <span>
                      Outstanding <b>{money(outstanding, currency)}</b>
                    </span>
                  </div>
                  <div className="collection-footer">
                    <ShieldCheck size={19} />
                    <span>
                      Balances reflect payments allocated to each invoice.
                    </span>
                    <button
                      className="text-button"
                      onClick={() => navigate("billing")}
                    >
                      View billing <ArrowRight size={16} />
                    </button>
                  </div>
                </section>
                <section className="service-card">
                  <div className="service-card-icon">
                    <Network size={24} />
                  </div>
                  <p className="eyebrow">SERVICE PORTFOLIO</p>
                  <h2>
                    {portal
                      ? "Your connection."
                      : "Built to keep you connected."}
                  </h2>
                  <p>
                    {portal
                      ? "Check your assigned plan and recorded service status."
                      : `${visible.plans.length} internet plans across the selected coverage.`}
                  </p>
                  <button
                    onClick={() => navigate(portal ? "services" : "plans")}
                  >
                    {portal ? "View my service" : "Explore internet plans"}
                    <ArrowUpRight size={18} />
                  </button>
                </section>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{portal ? "Your invoices" : "Needs your attention"}</h2>
                    <p>
                      {portal
                        ? "Open an invoice to view or print it."
                        : "Overdue invoices, ready for follow-up."}
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate("billing")}
                  >
                    All invoices <ArrowRight size={16} />
                  </button>
                </div>
                {invoiceTable(portal ? visible.invoices : due)}
              </section>
            </>
          )}
          {view === "subscribers" && (
            <section className="panel">
              <div className="table-toolbar">
                <label className="search-field">
                  <Search size={18} />
                  <input
                    aria-label="Search subscribers"
                    placeholder="Search name, account, contact, address or company…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <label className="filter-field">
                  <SlidersHorizontal size={16} />
                  <select
                    aria-label="Subscriber status"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="pending">Pending</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
                <label className="filter-field">
                  <Wifi size={16} />
                  <select aria-label="Subscriber plan" value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
                    <option value="all">All plans</option>
                    <option value="unassigned">Not assigned</option>
                    {visible.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}{showCompany ? ` · ${organizationFor(plan.organization_id)?.name ?? ""}` : ""}</option>)}
                  </select>
                </label>
                {hasSearchFilters && <button className="secondary filter-clear" onClick={clearSearchFilters}>Clear filters</button>}
                <span className="result-count">
                  {matchingSubscribers.length} subscribers
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Subscriber</th>
                      {showCompany && <th>Company</th>}
                      <th>Account</th>
                      <th>Plan</th>
                      <th>Service area</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {matchingSubscribers.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <button
                            className="person table-link"
                            onClick={() => openModal(s)}
                          >
                            <span className="avatar">
                              {s.name
                                .split(" ")
                                .slice(0, 2)
                                .map((n) => n[0])
                                .join("")}
                            </span>
                            <span>
                              {s.name}
                              <small>{s.email}</small>
                            </span>
                          </button>
                        </td>
                        {showCompany && <td>{organizationFor(s.organization_id)?.name}</td>}
                        <td className="mono">{s.account_number}</td>
                        <td>{planFor(s.id)?.name ?? "Not assigned"}</td>
                        <td>{s.address}</td>
                        <td>
                          <Status value={s.status} />
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`View ${s.name}`}
                            onClick={() => openModal(s)}
                          >
                            <ArrowUpRight size={18} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!matchingSubscribers.length && (
                  <p className="empty">
                    No subscribers found. Try another search or add a
                    subscriber.
                  </p>
                )}
              </div>
              <div className="table-footer">
                Showing {matchingSubscribers.length} of{" "}
                {visible.subscribers.length} loaded subscribers
              </div>
            </section>
          )}
          {view === "plans" && (
            <>
            <section className="panel search-toolbar-panel">
              <div className="table-toolbar">
                <label className="search-field"><Search size={18} /><input aria-label="Search plans" placeholder="Search plan, speed, price or company…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
                <label className="filter-field"><Gauge size={16} /><select aria-label="Download speed" value={speedFilter} onChange={(e) => setSpeedFilter(e.target.value)}><option value="all">All speeds</option><option value="up-to-100">Up to 100 Mbps</option><option value="101-500">101–500 Mbps</option><option value="501-plus">501+ Mbps</option></select></label>
                {hasSearchFilters && <button className="secondary filter-clear" onClick={clearSearchFilters}>Clear filters</button>}
                <span className="result-count">{matchingPlans.length} plans</span>
              </div>
            </section>
            <section className="plan-grid">
              {matchingPlans.map((p, index) => (
                <article
                  className={`plan-card ${index === 1 ? "featured" : ""}`}
                  key={p.id}
                >
                  <div className="plan-top">
                    <span className="plan-icon">
                      <Wifi size={23} />
                    </span>
                    <span className="subtle-chip">{showCompany ? organizationFor(p.organization_id)?.name : "FIBER"}</span>
                  </div>
                  <h2>{p.name}</h2>
                  <div className="plan-speed">
                    {p.download_mbps}
                    <span>Mbps</span>
                  </div>
                  <p>Download speed</p>
                  <div className="plan-price">
                    {money(p.price_minor, p.currency)}
                    <span>/ month</span>
                  </div>
                  <div className="plan-details">
                    <span>
                      Upload speed <b>{p.upload_mbps} Mbps</b>
                    </span>
                    <span>
                      Assigned services{" "}
                      <b>
                        {data.services.filter((s) => s.plan_id === p.id).length}
                      </b>
                    </span>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => navigate("services")}
                  >
                    View services
                    <ArrowRight size={16} />
                  </button>
                </article>
              ))}
              {!matchingPlans.length && (
                <p className="empty">
                  No plans match these search filters.
                </p>
              )}
            </section>
            </>
          )}
          {view === "services" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{portal ? "My service" : "Service assignments"}</h2>
                  <p>
                    These are recorded states. Router provisioning and live
                    network monitoring are not connected.
                  </p>
                </div>
                {!portal && (
                  <span className="subtle-chip">
                    {unassignedSubscribers.length} awaiting assignment
                  </span>
                )}
              </div>
              <div className="table-toolbar">
                <label className="search-field">
                  <Search size={18} />
                  <input aria-label="Search services" placeholder="Search subscriber, contact, address, plan or company…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <label className="filter-field">
                  <SlidersHorizontal size={16} />
                  <select aria-label="Service status" value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All services</option>
                    <option value="pending">Pending</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="terminated">Terminated</option>
                  </select>
                </label>
                <label className="filter-field"><Wifi size={16} /><select aria-label="Service plan" value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}><option value="all">All plans</option>{visible.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}{showCompany ? ` · ${organizationFor(plan.organization_id)?.name ?? ""}` : ""}</option>)}</select></label>
                {hasSearchFilters && <button className="secondary filter-clear" onClick={clearSearchFilters}>Clear filters</button>}
                <span className="result-count">{matchingServices.length} services</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Subscriber</th>
                      {showCompany && <th>Company</th>}
                      <th>Plan</th>
                      <th>Download / upload</th>
                      <th>Monthly price</th>
                      <th>Status</th>
                      {!portal && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {matchingServices.map((s) => {
                      const p = visible.plans.find((p) => p.id === s.plan_id);
                      return (
                        <tr key={s.id}>
                          <td>
                            {subscriberFor(s.subscriber_id)?.name ??
                              s.subscriber_id}
                          </td>
                          {showCompany && <td>{organizationFor(s.organization_id)?.name}</td>}
                          <td>{p?.name ?? "Unknown plan"}</td>
                          <td>
                            {p?.download_mbps} / {p?.upload_mbps} Mbps
                          </td>
                          <td>{p ? money(p.price_minor, p.currency) : "—"}</td>
                          <td>
                            <Status value={s.status} />
                          </td>
                          {!portal && (
                            <td>
                              <div className="service-actions">
                                {serviceLifecycleActions(s.status).map(
                                  (action) => {
                                    const noAlternativePlan =
                                      action === "change_plan" &&
                                      !visible.plans.some(
                                        (plan) => plan.organization_id === s.organization_id && plan.id !== s.plan_id,
                                      );
                                    return (
                                      <button
                                        key={action}
                                        className={
                                          action === "terminate"
                                            ? "table-action danger-action"
                                            : "table-action"
                                        }
                                        disabled={busy || noAlternativePlan}
                                        title={
                                          noAlternativePlan
                                            ? "Create another plan before changing this service"
                                            : undefined
                                        }
                                        onClick={() =>
                                          openModal({
                                            kind: "service-action",
                                            action,
                                            service: s,
                                          })
                                        }
                                      >
                                        {serviceActionLabels[action]}
                                      </button>
                                    );
                                  },
                                )}
                                {s.status === "terminated" && (
                                  <span className="muted-action">No actions</span>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!matchingServices.length && (
                  <p className="empty">
                    No services match this search and status filter.
                  </p>
                )}
              </div>
              <div className="table-footer">Showing {matchingServices.length} of {visible.services.length} loaded services</div>
            </section>
          )}
          {view === "billing" && (
            <section className="panel">
              <div className="panel-heading billing-heading">
                <div className="billing-tabs" role="tablist" aria-label="Billing records">
                  {!portal && <button className={billingTab === "dashboard" ? "selected" : "secondary"} onClick={() => { setBillingTab("dashboard"); clearSearchFilters(); }}>Dashboard</button>}
                  <button className={billingTab === "invoices" ? "selected" : "secondary"} onClick={() => { setBillingTab("invoices"); clearSearchFilters(); }}>Invoices</button>
                  <button className={billingTab === "payments" ? "selected" : "secondary"} onClick={() => { setBillingTab("payments"); clearSearchFilters(); }}>Payment history</button>
                </div>
                {!portal && <div className="dialog-actions">
                  <button className="secondary" onClick={() => openModal("payment")}><CreditCard size={16} /> Post payment</button>
                  <button onClick={() => openModal("invoice")}><FileText size={16} /> Generate invoice</button>
                </div>}
              </div>
              <div className="billing-filter-bar">
                {billingTab !== "dashboard" && <label className="search-field">
                    <Search size={18} />
                    <input
                      aria-label={`Search ${billingTab}`}
                      placeholder={billingTab === "invoices" ? "Search invoice, description, subscriber, date or company…" : "Search receipt, method, reference, subscriber or company…"}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>}
                {billingTab === "invoices" && <label className="filter-field">
                  <SlidersHorizontal size={16} />
                  <select
                    aria-label="Invoice status"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All invoices</option>
                    <option value="overdue">Overdue</option>
                    <option value="open">Open</option>
                    <option value="paid">Paid</option>
                  </select>
                </label>}
                {billingTab === "payments" && <label className="filter-field">
                  <CreditCard size={16} />
                  <select aria-label="Payment method" value={paymentMethodFilter} onChange={(e) => setPaymentMethodFilter(e.target.value)}>
                    <option value="all">All payment methods</option>
                    {Array.from(new Set(visible.payments.map((payment) => payment.payment_method))).sort().map((method) => <option key={method} value={method}>{method}</option>)}
                  </select>
                </label>}
                {hasSearchFilters && <button className="secondary filter-clear" onClick={clearSearchFilters}>Clear filters</button>}
                <div className="date-filters">
                  <label className="filter-field">
                    <CalendarDays size={16} />
                    <select
                      aria-label="Billing period"
                      value={billingPeriod}
                      onChange={(e) => setBillingPeriod(e.target.value as BillingPeriod)}
                    >
                      <option value="current-month">This month</option>
                      <option value="previous-month">Previous month</option>
                      <option value="month">Choose month</option>
                      <option value="custom">Date range</option>
                      <option value="all">All time</option>
                    </select>
                  </label>
                  {billingPeriod === "month" && <label className="date-input">
                    <span>Month</span>
                    <input type="month" value={billingMonth} onChange={(e) => setBillingMonth(e.target.value)} max={currentMonth} />
                  </label>}
                  {billingPeriod === "custom" && <>
                    <label className="date-input"><span>From</span><input type="date" value={billingFrom} onChange={(e) => setBillingFrom(e.target.value)} max={billingTo || today} /></label>
                    <label className="date-input"><span>To</span><input type="date" value={billingTo} onChange={(e) => setBillingTo(e.target.value)} min={billingFrom} max={today} /></label>
                  </>}
                </div>
              </div>
              {billingTab === "dashboard" && !portal ? (
                <div className="billing-dashboard">
                  <div className="billing-period-heading">
                    <div><p className="eyebrow">BILLING PERFORMANCE</p><h2>{periodLabel}</h2></div>
                    <span>{periodInvoices.length} invoices · {periodPayments.length} payments</span>
                  </div>
                  <div className="billing-kpis">
                    <article><span>Issued</span><strong>{money(periodBilled, currency)}</strong><small>{periodInvoices.length} invoices in period</small></article>
                    <article><span>Collected</span><strong>{money(periodCollected, currency)}</strong><small>{collectionRate}% of issued value</small></article>
                    <article><span>Outstanding</span><strong>{money(periodOutstanding, currency)}</strong><small>Balance on filtered invoices</small></article>
                    <article className={periodOverdue.length ? "billing-alert" : ""}><span>Overdue</span><strong>{periodOverdue.length}</strong><small>{periodOverdue.length ? money(periodOverdue.reduce((sum, invoice) => sum + balance(invoice), 0), currency) + " to follow up" : "No overdue invoices"}</small></article>
                  </div>
                  <div className="billing-insights">
                    <article className="billing-card activity-card">
                      <div className="billing-card-heading"><div><h3>Billing activity</h3><p>Issued and received on each active date</p></div><div className="chart-legend"><span><i className="issued-key" />Issued</span><span><i className="collected-key" />Collected</span></div></div>
                      {activityByDate.length ? <div className="activity-chart" aria-label="Billing activity chart">
                        {activityByDate.map((item) => <div className="activity-row" key={item.date}>
                          <span>{compactDate(item.date)}</span>
                          <div className="activity-bars">
                            <i className="issued-bar" style={{ width: `${Math.max(item.billed ? 3 : 0, (item.billed / activityPeak) * 100)}%` }} title={`Issued ${money(item.billed, currency)}`} />
                            <i className="collected-bar" style={{ width: `${Math.max(item.collected ? 3 : 0, (item.collected / activityPeak) * 100)}%` }} title={`Collected ${money(item.collected, currency)}`} />
                          </div>
                          <strong>{money(item.billed + item.collected, currency)}</strong>
                        </div>)}
                      </div> : <p className="empty compact-empty">No billing activity in this period.</p>}
                    </article>
                    <article className="billing-card">
                      <div className="billing-card-heading"><div><h3>Outstanding accounts</h3><p>Largest balances from filtered invoices</p></div></div>
                      {outstandingAccounts.length ? <ol className="outstanding-list">
                        {outstandingAccounts.map(([subscriberId, amount]) => <li key={subscriberId}>
                          <span><b>{subscriberFor(subscriberId)?.name ?? "Subscriber"}</b><small>{subscriberFor(subscriberId)?.account_number ?? "Account unavailable"}{showCompany ? ` · ${organizationFor(subscriberFor(subscriberId)?.organization_id ?? "")?.name ?? ""}` : ""}</small></span>
                          <strong>{money(amount, currency)}</strong>
                        </li>)}
                      </ol> : <p className="empty compact-empty">No outstanding balances in this period.</p>}
                    </article>
                  </div>
                </div>
              ) : billingTab === "invoices" ? invoiceTable(matchingInvoices) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Receipt</th>{showCompany && <th>Company</th>}{!portal && <th>Subscriber</th>}<th>Received</th><th>Method / reference</th><th>Invoice</th><th>Amount</th><th><span className="sr-only">Open receipt</span></th></tr></thead>
                    <tbody>{matchingPayments.map((payment) => {
                      const allocation = visible.allocations.find((item) => item.payment_id === payment.id);
                      const invoice = visible.invoices.find((item) => item.id === allocation?.invoice_id);
                      return <tr key={payment.id}>
                        <td><button className="table-link" onClick={() => openModal(payment)}>{payment.receipt_number}</button></td>
                        {showCompany && <td>{organizationFor(payment.organization_id)?.name}</td>}
                        {!portal && <td>{subscriberFor(payment.subscriber_id)?.name ?? "Subscriber outside loaded page"}</td>}
                        <td>{payment.received_at.slice(0, 10)}</td>
                        <td>{payment.payment_method}<small className="table-subtext">{payment.reference}</small></td>
                        <td>{invoice?.number ?? "Unallocated"}</td>
                        <td className="numeric">{money(payment.amount_minor, payment.currency)}</td>
                        <td><button className="icon-button" aria-label={`View ${payment.receipt_number}`} onClick={() => openModal(payment)}><ArrowUpRight size={18} /></button></td>
                      </tr>;
                    })}</tbody>
                  </table>
                  {!matchingPayments.length && <p className="empty">No payments match this search.</p>}
                </div>
              )}
              <div className="table-footer">
                {billingTab === "dashboard" ? `${periodLabel} · figures use the loaded billing records` : billingTab === "invoices" ? `${matchingInvoices.length} invoices` : `${matchingPayments.length} recorded payments`}
              </div>
            </section>
          )}
          {view === "account" && portal && visible.subscribers[0] && (
            <div className="reports-grid account-grid">
              <section className="panel">
                <div className="panel-heading"><div><h2>Contact information</h2><p>Keep your billing and service contact details current.</p></div></div>
                <form onSubmit={saveContact}>
                  <label>Email<input name="email" type="email" defaultValue={visible.subscribers[0].email} required /></label>
                  <label>Phone<input name="phone" type="tel" maxLength={40} defaultValue={visible.subscribers[0].phone} /></label>
                  <label>Service address<textarea name="address" minLength={3} maxLength={300} defaultValue={visible.subscribers[0].address} required /></label>
                  <p role="alert" className="form-message">{error}</p>
                  <button disabled={busy}>{busy ? "Saving…" : "Save contact information"}</button>
                </form>
              </section>
              <section className="panel">
                <div className="panel-heading"><div><h2>Change password</h2><p>Use a unique password with at least 12 characters.</p></div></div>
                <form onSubmit={savePassword}>
                  <label>New password<input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
                  <label>Confirm new password<input name="confirm_password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
                  <p role="alert" className="form-message">{error}</p>
                  <button disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
                </form>
              </section>
            </div>
          )}
          {view === "reports" && (
            <div className="reports-grid">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Receivables summary</h2>
                </div>
                <dl className="summary-list">
                  <div>
                    <dt>Total invoiced</dt>
                    <dd>{money(billed, currency)}</dd>
                  </div>
                  <div>
                    <dt>Allocated collections</dt>
                    <dd>{money(collected, currency)}</dd>
                  </div>
                  <div>
                    <dt>Outstanding balance</dt>
                    <dd>{money(outstanding, currency)}</dd>
                  </div>
                  <div>
                    <dt>Overdue balance</dt>
                    <dd>
                      {money(
                        due.reduce((sum, i) => sum + balance(i), 0),
                        currency,
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="panel-note">
                  Loaded records only. This is not a tax, bank reconciliation or
                  recognized-revenue report.
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Subscriber summary</h2>
                </div>
                <dl className="summary-list">
                  {["active", "pending", "suspended"].map((status) => (
                    <div key={status}>
                      <dt>
                        <Status value={status} />
                      </dt>
                      <dd>
                        {
                          visible.subscribers.filter((s) => s.status === status)
                            .length
                        }
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          )}
          {view === "audit" && role === "admin" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Workspace activity</h2>
                  <p>
                    {isDemo
                      ? "Sample events and changes from this demo session."
                      : "Latest 50 subscriber, plan, and service lifecycle events."}
                  </p>
                </div>
              </div>
              <div className="table-toolbar audit-filters">
                <label className="search-field"><Search size={18} /><input aria-label="Search audit log" placeholder="Search action, record type, date or company…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
                <label className="filter-field"><ShieldCheck size={16} /><select aria-label="Audit record type" value={auditEntityFilter} onChange={(e) => setAuditEntityFilter(e.target.value)}><option value="all">All record types</option>{Array.from(new Set(visible.audit.map((event) => event.entity_type))).sort().map((entity) => <option key={entity} value={entity}>{entity}</option>)}</select></label>
                <label className="date-input"><span>From</span><input type="date" value={auditFrom} onChange={(e) => setAuditFrom(e.target.value)} max={auditTo || today} /></label>
                <label className="date-input"><span>To</span><input type="date" value={auditTo} onChange={(e) => setAuditTo(e.target.value)} min={auditFrom} max={today} /></label>
                {hasSearchFilters && <button className="secondary filter-clear" onClick={clearSearchFilters}>Clear filters</button>}
                <span className="result-count">{matchingAudit.length} events</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Action</th>
                      {showCompany && <th>Company</th>}
                      <th>Record type</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchingAudit.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <ShieldCheck size={15} className="inline-icon" />
                          {a.action}
                        </td>
                        {showCompany && <td>{organizationFor(a.organization_id)?.name}</td>}
                        <td>{a.entity_type}</td>
                        <td>
                          {a.created_at.replace("T", " ").slice(0, 19)} UTC
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!matchingAudit.length && (
                  <p className="empty">No events match these filters.</p>
                )}
              </div>
            </section>
          )}
          <footer className="workspace-footer">
            <span>
              SOUTHWOODS <b>·</b> ISP operations
            </span>
            <span>
              {isDemo
                ? "Sample data as of September 14, 2026"
                : "Foundation v0.1 · Not production-complete"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            className="icon-button"
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Dialog
          title={
            modal === "subscriber"
              ? "Add subscriber"
              : modal === "plan"
                ? "Create internet plan"
                : modal === "assignment"
                  ? "Assign internet plan"
                  : modal === "invoice"
                    ? "Generate invoice"
                    : modal === "payment"
                      ? "Post payment"
                  : "kind" in modal
                    ? serviceActionLabels[modal.action]
                  : "receipt_number" in modal
                    ? "Receipt details"
                  : "number" in modal
                    ? "Invoice details"
                    : "Subscriber profile"
          }
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal === "subscriber" ? (
            <form onSubmit={saveSubscriber}>
              <p className="dialog-note">
                {isDemo
                  ? "Create a sample record. It will not be sent to Supabase."
                  : "Creates a pending subscriber. Login activation is a separate provisioning step."}
              </p>
              {role === "admin" && <label>
                Company
                <select name="organization_id" defaultValue={selectedOrganizationId === "all" ? "" : selectedOrganizationId} required>
                  <option value="" disabled>Select a company</option>
                  {data.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
                </select>
              </label>}
              <label>
                Full name
                <input name="name" minLength={2} maxLength={120} required />
              </label>
              <label>
                Account number
                <input
                  name="account_number"
                  placeholder="SLI-001007 or CAR-001007"
                  pattern="[A-Z0-9-]{3,30}"
                  required
                />
                <small>Uppercase letters, numbers and hyphens.</small>
              </label>
              <label>
                Email
                <input name="email" type="email" required />
              </label>
              <label>
                Phone
                <input name="phone" type="tel" maxLength={40} />
              </label>
              <label>
                Service address
                <input name="address" minLength={3} maxLength={300} required />
              </label>
              <p role="alert" className="form-message">
                {error}
              </p>
              <button disabled={busy}>
                {busy ? "Saving…" : "Create subscriber"}
              </button>
            </form>
          ) : modal === "plan" ? (
            <form onSubmit={savePlan}>
              {role === "admin" && <label>
                Company
                <select name="organization_id" defaultValue={selectedOrganizationId === "all" ? "" : selectedOrganizationId} required>
                  <option value="" disabled>Select a company</option>
                  {data.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
                </select>
              </label>}
              <label>
                Plan name
                <input name="name" minLength={2} maxLength={100} required />
              </label>
              <div className="form-row">
                <label>
                  Download (Mbps)
                  <input
                    name="download_mbps"
                    type="number"
                    min={1}
                    max={100000}
                    required
                  />
                </label>
                <label>
                  Upload (Mbps)
                  <input
                    name="upload_mbps"
                    type="number"
                    min={1}
                    max={100000}
                    required
                  />
                </label>
              </div>
              <label>
                Monthly price ({currency})
                <input
                  name="price"
                  type="number"
                  step="0.01"
                  min="0"
                  max="99999999.99"
                  required
                />
              </label>
              <p role="alert" className="form-message">
                {error}
              </p>
              <button disabled={busy}>
                {busy ? "Saving…" : "Create plan"}
              </button>
            </form>
          ) : modal === "assignment" ? (
            <form onSubmit={saveAssignment}>
              <p className="dialog-note">
                Creates a pending service assignment. It does not configure a
                router, ONT, VLAN, or MikroTik device.
              </p>
              <label>
                Subscriber
                <select name="subscriber_id" defaultValue="" required>
                  <option value="" disabled>
                    Select an unassigned subscriber
                  </option>
                  {unassignedSubscribers.map((subscriber) => (
                    <option key={subscriber.id} value={subscriber.id}>
                      {subscriber.account_number} — {subscriber.name} · {organizationFor(subscriber.organization_id)?.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Internet plan
                <select name="plan_id" defaultValue="" required>
                  <option value="" disabled>
                    Select a plan
                  </option>
                  {visible.plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} — {plan.download_mbps}/{plan.upload_mbps} Mbps · {organizationFor(plan.organization_id)?.name}
                    </option>
                  ))}
                </select>
              </label>
              <p role="alert" className="form-message">
                {error}
              </p>
              <button disabled={busy}>
                {busy ? "Assigning…" : "Assign plan"}
              </button>
            </form>
          ) : modal === "invoice" ? (
            <form onSubmit={saveInvoice}>
              <p className="dialog-note">Creates an immutable, sequentially numbered invoice. Confirm all details before posting.</p>
              <label>Subscriber<select name="subscriber_id" defaultValue="" required><option value="" disabled>Select a subscriber</option>{visible.subscribers.map((subscriber) => <option key={subscriber.id} value={subscriber.id}>{subscriber.account_number} — {subscriber.name} · {organizationFor(subscriber.organization_id)?.name}</option>)}</select></label>
              <div className="form-row">
                <label>Issue date<input name="issued_on" type="date" defaultValue={today} required /></label>
                <label>Due date<input name="due_on" type="date" min={today} defaultValue={today} required /></label>
              </div>
              <label>Description<textarea name="description" minLength={2} maxLength={500} placeholder="Monthly internet service" required /></label>
              <label>Total ({currency})<input name="total" type="number" min="0.01" max="99999999.99" step="0.01" required /></label>
              <p role="alert" className="form-message">{error}</p>
              <button disabled={busy}>{busy ? "Generating…" : "Generate invoice"}</button>
            </form>
          ) : modal === "payment" ? (
            <form onSubmit={savePayment}>
              <p className="dialog-note">Posts an immutable payment, allocates it to one invoice, and creates the next receipt number.</p>
              <label>Open invoice<select name="invoice_id" defaultValue="" required><option value="" disabled>Select an invoice</option>{visible.invoices.filter((invoice) => balance(invoice) > 0).map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} — {subscriberFor(invoice.subscriber_id)?.name} — {money(balance(invoice), invoice.currency)} due · {organizationFor(invoice.organization_id)?.name}</option>)}</select></label>
              <label>Amount ({currency})<input name="amount" type="number" min="0.01" max="99999999.99" step="0.01" required /></label>
              <label>Payment method<select name="payment_method" defaultValue=""><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>Card</option><option>Other</option></select></label>
              <label>External reference<input name="reference" minLength={2} maxLength={100} placeholder="Transaction or deposit reference" required /></label>
              <p role="alert" className="form-message">{error}</p>
              <button disabled={busy}>{busy ? "Posting…" : "Post payment and create receipt"}</button>
            </form>
          ) : "kind" in modal ? (
            <form onSubmit={saveServiceAction}>
              <p className="dialog-note">
                {modal.action === "change_plan"
                  ? `Choose a replacement plan for ${subscriberFor(modal.service.subscriber_id)?.name ?? "this subscriber"}.`
                  : modal.action === "terminate"
                    ? "Termination is final. The subscriber will need a new service assignment to reconnect later."
                    : `${serviceActionLabels[modal.action]} this service. A mapped router queue receives the current plan bandwidth when active, or the 1k restriction when suspended or terminated. Router changes are queued and confirmed separately.`}
              </p>
              {modal.action === "change_plan" && (
                <label>
                  New internet plan
                  <select name="plan_id" defaultValue="" required>
                    <option value="" disabled>
                      Select a different plan
                    </option>
                    {visible.plans
                      .filter((plan) => plan.organization_id === modal.service.organization_id && plan.id !== modal.service.plan_id)
                      .map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} — {plan.download_mbps}/{plan.upload_mbps} Mbps
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <p role="alert" className="form-message">
                {error}
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  className={modal.action === "terminate" ? "danger-button" : ""}
                  disabled={busy}
                >
                  {busy
                    ? "Saving…"
                    : serviceActionLabels[modal.action]}
                </button>
              </div>
            </form>
          ) : "receipt_number" in modal ? (
            <div className="invoice-document">
              <div className="invoice-brand">SOUTHWOODS <span>{isDemo ? "SAMPLE RECEIPT" : "OFFICIAL RECEIPT"}</span></div>
              <h3>{modal.receipt_number}</h3>
              <p>{subscriberFor(modal.subscriber_id)?.name}</p>
              <dl className="summary-list">
                <div><dt>Received</dt><dd>{modal.received_at.slice(0, 10)}</dd></div>
                <div><dt>Amount</dt><dd>{money(modal.amount_minor, modal.currency)}</dd></div>
                <div><dt>Payment method</dt><dd>{modal.payment_method}</dd></div>
                <div><dt>Reference</dt><dd>{modal.reference}</dd></div>
              </dl>
              <button onClick={() => {
                const subscriber = subscriberFor(modal.subscriber_id);
                const allocation = visible.allocations.find((item) => item.payment_id === modal.id);
                const invoice = visible.invoices.find((item) => item.id === allocation?.invoice_id);
                const organization = organizationFor(modal.organization_id);
                if (subscriber && organization) void downloadReceiptPdf(modal, invoice, subscriber, organization);
              }}><ArrowDownToLine size={17} /> Download receipt PDF</button>
            </div>
          ) : "number" in modal ? (
            <div className="invoice-document">
              <div className="invoice-brand">
                SOUTHWOODS{" "}
                <span>
                  {isDemo ? "SAMPLE INVOICE" : "OFFICIAL INVOICE"}
                </span>
              </div>
              <h3>{modal.number}</h3>
              <p>{subscriberFor(modal.subscriber_id)?.name}</p>
              <dl className="summary-list">
                <div>
                  <dt>Issued</dt>
                  <dd>{modal.issued_on}</dd>
                </div>
                <div>
                  <dt>Due</dt>
                  <dd>{modal.due_on}</dd>
                </div>
                <div>
                  <dt>Invoice total</dt>
                  <dd>{money(modal.total_minor, modal.currency)}</dd>
                </div>
                <div>
                  <dt>Payments allocated</dt>
                  <dd>{money(modal.paid_minor, modal.currency)}</dd>
                </div>
                <div>
                  <dt>Outstanding</dt>
                  <dd>{money(balance(modal), modal.currency)}</dd>
                </div>
              </dl>
              <p className="dialog-note">{modal.description}</p>
              <button onClick={() => {
                const subscriber = subscriberFor(modal.subscriber_id);
                const organization = organizationFor(modal.organization_id);
                if (subscriber && organization) void downloadInvoicePdf(modal, subscriber, organization);
              }}>
                <ArrowDownToLine size={17} />
                Download invoice PDF
              </button>
            </div>
          ) : (
            <div>
              <div className="profile-title">
                <span className="avatar large">
                  {modal.name
                    .split(" ")
                    .slice(0, 2)
                    .map((n) => n[0])
                    .join("")}
                </span>
                <div>
                  <h3>{modal.name}</h3>
                  <p>{modal.account_number}</p>
                </div>
              </div>
              <dl className="summary-list">
                <div>
                  <dt>Email</dt>
                  <dd>{modal.email}</dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{modal.phone || "Not provided"}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>{modal.address}</dd>
                </div>
                <div>
                  <dt>Account status</dt>
                  <dd>
                    <Status value={modal.status} />
                  </dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>{planFor(modal.id)?.name ?? "Not assigned"}</dd>
                </div>
                {(() => {
                  const identity = data.networkIdentities.find((item) => item.subscriber_id === modal.id);
                  if (!identity) return <div><dt>Network identity</dt><dd>Not linked</dd></div>;
                  const recent = identity.network_seen_at && Date.now() - Date.parse(identity.network_seen_at) <= 180_000;
                  return <>
                    <div><dt>Network identity</dt><dd>{identity.mac_address ? (recent ? "DHCP verified" : "ONU linked") : "IP linked"}</dd></div>
                    <div><dt>MikroTik ONU / MAC</dt><dd className="mono">{identity.mac_address ?? "Not observed"}</dd></div>
                    <div><dt>IP address</dt><dd className="mono">{identity.ip_address}</dd></div>
                    <div><dt>DHCP hostname</dt><dd>{identity.dhcp_host_name || "Not reported"}</dd></div>
                    <div><dt>DHCP status</dt><dd>{identity.dhcp_status || "Unknown"}</dd></div>
                    <div><dt>Last network sighting</dt><dd>{identity.network_seen_at ? new Date(identity.network_seen_at).toLocaleString() : "Not observed"}</dd></div>
                  </>;
                })()}
              </dl>
              <button
                className="secondary"
                onClick={() => {
                  setModal(null);
                  navigate("billing");
                  setQuery(modal.name);
                }}
              >
                View invoices <ArrowRight size={16} />
              </button>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
