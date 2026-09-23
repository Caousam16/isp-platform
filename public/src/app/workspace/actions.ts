"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireMembership } from "@/lib/access";
import { toMinorUnits } from "@/lib/domain";
import type { Invoice, Payment, PaymentAllocation, Service, Subscriber } from "@/lib/domain";

function revalidateWorkspaces() {
  revalidatePath("/admin");
  revalidatePath("/portal");
}
export async function createSubscriber(input: unknown) {
  const { client, role, organizationId } = await requireMembership(
    "/operations/sign-in",
  );
  if (role === "subscriber")
    return { error: "You do not have permission to create subscribers." };
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(120),
      email: z.email(),
      phone: z.string().trim().max(40).default(""),
      address: z.string().trim().min(3).max(300),
      account_number: z.string().regex(/^[A-Z0-9-]{3,30}$/),
      organization_id: z.uuid().optional(),
    })
    .safeParse(input);
  if (!parsed.success)
    return { error: "Check the name, email, address and account number." };
  const targetOrganizationId =
    role === "admin" ? (parsed.data.organization_id ?? organizationId) : organizationId;
  const writeClient = client;
  const { data: targetOrganization } = await writeClient
    .from("organizations")
    .select("id")
    .eq("id", targetOrganizationId)
    .maybeSingle();
  if (!targetOrganization) return { error: "Choose a company you can access." };
  const { organization_id: _requestedOrganizationId, ...subscriberFields } = parsed.data;
  const { data, error } = await writeClient
    .from("subscribers")
    .insert({
      ...subscriberFields,
      organization_id: targetOrganizationId,
      status: "pending",
    })
    .select("id, organization_id, name, email, phone, address, account_number, status")
    .single();
  if (error)
    return {
      error:
        error.code === "23505"
          ? "That account number is already in use."
          : "Could not create the subscriber. Check permissions and try again.",
    };
  revalidateWorkspaces();
  return { data };
}
export async function createPlan(input: unknown) {
  const { client, role, organizationId } = await requireMembership(
    "/operations/sign-in",
  );
  if (role !== "admin")
    return { error: "Only administrators can create plans." };
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(100),
      download_mbps: z.coerce.number().int().min(1).max(100000),
      upload_mbps: z.coerce.number().int().min(1).max(100000),
      price: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
      organization_id: z.uuid().optional(),
    })
    .safeParse(input);
  if (!parsed.success)
    return { error: "Check the plan name, speeds and monthly price." };
  const { price, organization_id: requestedOrganizationId, ...fields } = parsed.data;
  const targetOrganizationId =
    role === "admin" ? (requestedOrganizationId ?? organizationId) : organizationId;
  const writeClient = client;
  const { data: organization, error: orgError } = await writeClient
    .from("organizations")
    .select("currency")
    .eq("id", targetOrganizationId)
    .single();
  if (orgError || !organization)
    return { error: "Could not read organization currency." };
  const { data, error } = await writeClient
    .from("plans")
    .insert({
      ...fields,
      organization_id: targetOrganizationId,
      price_minor: toMinorUnits(price),
      currency: organization.currency,
    })
    .select("id, organization_id, name, download_mbps, upload_mbps, price_minor, currency")
    .single();
  if (error)
    return {
      error: "Could not create the plan. Check permissions and try again.",
    };
  revalidateWorkspaces();
  return { data };
}

export async function assignPlan(input: unknown) {
  const { client, role } = await requireMembership(
    "/operations/sign-in",
  );
  if (role === "subscriber")
    return { error: "You do not have permission to assign plans." };
  const parsed = z
    .object({
      subscriber_id: z.uuid(),
      plan_id: z.uuid(),
    })
    .safeParse(input);
  if (!parsed.success)
    return { error: "Choose a valid subscriber and internet plan." };
  const writeClient = client;
  const { data: subscriber, error: subscriberError } = await writeClient
    .from("subscribers")
    .select("organization_id")
    .eq("id", parsed.data.subscriber_id)
    .single();
  const { data: plan, error: planError } = await writeClient
    .from("plans")
    .select("organization_id")
    .eq("id", parsed.data.plan_id)
    .single();
  if (subscriberError || planError || !subscriber || !plan || subscriber.organization_id !== plan.organization_id)
    return { error: "Subscriber and plan must belong to the same accessible company." };
  const { data, error } = await writeClient
    .from("subscriber_services")
    .insert({
      organization_id: subscriber.organization_id,
      subscriber_id: parsed.data.subscriber_id,
      plan_id: parsed.data.plan_id,
      status: "pending",
    })
    .select("id, organization_id, subscriber_id, plan_id, status")
    .single();
  if (error)
    return {
      error:
        error.code === "23505"
          ? "That subscriber already has a current service assignment."
          : "Could not assign the plan. Check access and try again.",
    };
  revalidatePath("/admin");
  return { data };
}

export async function manageService(input: unknown) {
  const { client, role, userId } = await requireMembership("/operations/sign-in");
  if (role === "subscriber")
    return { error: "You do not have permission to manage services." };

  const parsed = z
    .object({
      service_id: z.uuid(),
      action: z.enum([
        "activate",
        "suspend",
        "reconnect",
        "terminate",
        "change_plan",
      ]),
      plan_id: z.uuid().nullable().optional(),
    })
    .superRefine((value, context) => {
      if (value.action === "change_plan" && !value.plan_id) {
        context.addIssue({
          code: "custom",
          path: ["plan_id"],
          message: "Choose an internet plan.",
        });
      }
    })
    .safeParse(input);

  if (!parsed.success)
    return { error: "Choose a valid service action and internet plan." };

  if(role === "staff" && parsed.data.action !== "suspend") return {error:"Only administrators can perform this service action."};
  const { data, error } = await client.rpc("manage_subscriber_service", {
    p_service_id: parsed.data.service_id,
    p_action: parsed.data.action,
    p_plan_id: parsed.data.plan_id ?? null,
  });

  if (error) {
    const expectedMessage = [
      "Only pending services can be activated",
      "Router snapshot is stale; refresh before changing this service",
      "Router queue changed; refresh before changing this service",
      "Mapped ONU has no eligible queue; refresh and verify its DHCP identity",
      "A router command needs completion or reconciliation before another change",
      "Only active services can be suspended",
      "Only suspended services can be reconnected",
      "Service is already terminated",
      "A terminated service cannot change plans",
      "Service is already on this plan",
    ].find((message) => error.message.includes(message));
    return {
      error:
        expectedMessage ??
        "Could not update the service. Refresh and try again.",
    };
  }

  const service = (Array.isArray(data) ? data[0] : data) as Service | null;
  if (!service) return { error: "The service update returned no record." };

  const routerNotice = "Service recorded. Mapped router changes are queued; check command history for confirmation.";

  revalidateWorkspaces();
  revalidatePath("/admin/routers");
  return {
    routerNotice,
    data: {
      id: service.id,
      organization_id: service.organization_id,
      subscriber_id: service.subscriber_id,
      plan_id: service.plan_id,
      status: service.status,
    } satisfies Service,
  };
}

export async function updateSubscriberContact(input: unknown) {
  const { client, role, userId } = await requireMembership("/login");
  if (role !== "subscriber")
    return { error: "Only subscribers can update their portal contact details." };
  const parsed = z.object({
    email: z.email().max(254),
    phone: z.string().trim().max(40),
    address: z.string().trim().min(3).max(300),
  }).safeParse(input);
  if (!parsed.success)
    return { error: "Check the email, phone number and service address." };
  const { data, error } = await client
    .from("subscribers")
    .update(parsed.data)
    .eq("user_id", userId)
    .select("id, organization_id, account_number, name, email, phone, address, status")
    .single();
  if (error || !data)
    return { error: "Could not update your contact information." };
  revalidateWorkspaces();
  return { data: data as Subscriber };
}

export async function changeSubscriberPassword(input: unknown) {
  const { client, role } = await requireMembership("/login");
  if (role !== "subscriber")
    return { error: "Only subscribers can change a portal password here." };
  const parsed = z.object({
    password: z.string().min(12).max(72),
    confirm_password: z.string(),
  }).refine((value) => value.password === value.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords do not match.",
  }).safeParse(input);
  if (!parsed.success)
    return { error: "Use a matching password between 12 and 72 characters." };
  const { error } = await client.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: "Could not change your password. Sign in again and retry." };
  return { success: true as const };
}

export async function createInvoice(input: unknown) {
  const { client, role } = await requireMembership("/operations/sign-in");
  if (role === "subscriber") return { error: "You do not have permission to create invoices." };
  const parsed = z.object({
    request_id: z.uuid(),
    subscriber_id: z.uuid(),
    issued_on: z.iso.date(),
    due_on: z.iso.date(),
    description: z.string().trim().min(2).max(500),
    total: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
  }).safeParse(input);
  if (!parsed.success) return { error: "Check the subscriber, dates, description and total." };
  let totalMinor: number;
  try { totalMinor = toMinorUnits(parsed.data.total); }
  catch { return { error: "Enter a valid invoice total." }; }
  if (totalMinor === 0) return { error: "Invoice total must be greater than zero." };
  const { data, error } = await client.rpc("create_invoice", {
    p_request_id: parsed.data.request_id,
    p_subscriber_id: parsed.data.subscriber_id,
    p_issued_on: parsed.data.issued_on,
    p_due_on: parsed.data.due_on,
    p_description: parsed.data.description,
    p_total_minor: totalMinor,
  });
  if (error) {
    const expected = ["Due date cannot be before issue date", "Subscriber not found"]
      .find((message) => error.message.includes(message));
    return { error: expected ?? "Could not generate the invoice." };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Omit<Invoice, "paid_minor"> | null;
  if (!row) return { error: "Invoice generation returned no record." };
  revalidateWorkspaces();
  return { data: { ...row, paid_minor: 0 } as Invoice };
}

export async function postPayment(input: unknown) {
  const { client, role } = await requireMembership("/operations/sign-in");
  if (role === "subscriber") return { error: "You do not have permission to post payments." };
  const parsed = z.object({
    request_id: z.uuid(),
    invoice_id: z.uuid(),
    amount: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
    payment_method: z.string().trim().min(2).max(60),
    reference: z.string().trim().min(2).max(100),
  }).safeParse(input);
  if (!parsed.success) return { error: "Check the invoice, amount, method and reference." };
  let amountMinor: number;
  try { amountMinor = toMinorUnits(parsed.data.amount); }
  catch { return { error: "Enter a valid payment amount." }; }
  const { data, error } = await client.rpc("post_invoice_payment", {
    p_request_id: parsed.data.request_id,
    p_invoice_id: parsed.data.invoice_id,
    p_amount_minor: amountMinor,
    p_payment_method: parsed.data.payment_method,
    p_reference: parsed.data.reference,
  });
  if (error) {
    const expected = ["Payment exceeds the invoice balance", "Invoice not found"]
      .find((message) => error.message.includes(message));
    return { error: expected ?? "Could not post the payment." };
  }
  const result = data as { payment?: Payment; allocation?: PaymentAllocation } | null;
  if (!result?.payment || !result.allocation)
    return { error: "Payment posting returned an incomplete record." };
  revalidateWorkspaces();
  return { data: { payment: result.payment, allocation: result.allocation } };
}
