"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMembership } from "@/lib/access";
import { subscriberLoginEmail } from "@/lib/domain";
import { createAdminClient } from "@/lib/supabase/admin";

type ActionResult = { success?: string; error?: string };

const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(72, "Use no more than 72 characters.");

async function removeProvisionedUser(
  userId: string,
  subscriberId?: string,
): Promise<boolean> {
  const admin = createAdminClient();
  let unlinkFailed = false;
  if (subscriberId) {
    const { error } = await admin
      .from("subscribers")
      .update({ user_id: null })
      .eq("id", subscriberId)
      .eq("user_id", userId);
    unlinkFailed = Boolean(error);
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  return !unlinkFailed && !error;
}

function rollbackMessage(cleanedUp: boolean, operation: string) {
  return cleanedUp
    ? `${operation} No login was retained.`
    : `${operation} An incomplete Auth user may remain; ask an administrator to inspect Supabase Auth.`;
}

export async function createStaffCredential(
  input: unknown,
): Promise<ActionResult> {
  const actor = await requireMembership("/operations/sign-in");
  if (actor.role !== "admin") {
    return { error: "Only administrators can create staff accounts." };
  }
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(120),
      email: z.email().transform((value) => value.trim().toLowerCase()),
      organization_id: z.uuid(),
      password: passwordSchema,
      confirm_password: z.string(),
    })
    .refine((value) => value.password === value.confirm_password, {
      message: "Passwords do not match.",
      path: ["confirm_password"],
    })
    .safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the account details." };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: "Credential provisioning is not configured on the server." };
  }
  const { name, email, password, organization_id: organizationId } = parsed.data;
  const { data: organization } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", organizationId)
    .maybeSingle();
  if (!organization) return { error: "Choose a company you can access." };
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (error || !data.user) {
    return {
      error: error?.message.toLowerCase().includes("registered")
        ? "That email already has an account."
        : "Could not create the staff login.",
    };
  }

  const { error: membershipError } = await admin.from("memberships").insert({
    user_id: data.user.id,
    organization_id: organizationId,
    role: "staff",
    status: "active",
  });
  if (membershipError) {
    const cleanedUp = await removeProvisionedUser(data.user.id);
    return { error: rollbackMessage(cleanedUp, "Could not assign the staff role.") };
  }
  const { error: auditError } = await admin.from("audit_events").insert({
    organization_id: organizationId,
    actor_id: actor.userId,
    action: "staff.credentials.created",
    entity_type: "auth_user",
    entity_id: data.user.id,
  });
  if (auditError) {
    const cleanedUp = await removeProvisionedUser(data.user.id);
    return { error: rollbackMessage(cleanedUp, "Could not record the security audit.") };
  }

  revalidatePath("/admin/access");
  return { success: `Staff login created for ${email} in ${organization.name}.` };
}

export async function createSubscriberCredential(
  input: unknown,
): Promise<ActionResult> {
  const actor = await requireMembership("/operations/sign-in");
  if (actor.role !== "admin" && actor.role !== "staff") {
    return { error: "You do not have permission to create subscriber logins." };
  }
  const parsed = z
    .object({
      subscriber_id: z.uuid(),
      password: passwordSchema,
      confirm_password: z.string(),
    })
    .refine((value) => value.password === value.confirm_password, {
      message: "Passwords do not match.",
      path: ["confirm_password"],
    })
    .safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the account details." };
  }

  const { data: subscriber, error: subscriberError } = await actor.client
    .from("subscribers")
    .select("id, organization_id, account_number, user_id, status")
    .eq("id", parsed.data.subscriber_id)
    .single();
  if (subscriberError || !subscriber) {
    return { error: "Subscriber not found or inaccessible." };
  }
  if (subscriber.user_id) {
    return { error: "That subscriber already has a login." };
  }
  if (subscriber.status === "suspended") {
    return { error: "Reactivate the subscriber before creating a login." };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: "Credential provisioning is not configured on the server." };
  }
  const loginEmail = subscriberLoginEmail(subscriber.account_number);
  const { data, error } = await admin.auth.admin.createUser({
    email: loginEmail,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { account_number: subscriber.account_number },
  });
  if (error || !data.user) {
    return {
      error: error?.message.toLowerCase().includes("registered")
        ? "That account number already has an Auth login."
        : "Could not create the subscriber login.",
    };
  }

  const { error: membershipError } = await admin.from("memberships").insert({
    user_id: data.user.id,
    organization_id: subscriber.organization_id,
    role: "subscriber",
    status: "active",
  });
  if (membershipError) {
    const cleanedUp = await removeProvisionedUser(data.user.id);
    return { error: rollbackMessage(cleanedUp, "Could not assign subscriber access.") };
  }
  const { error: linkError } = await admin
    .from("subscribers")
    .update({ user_id: data.user.id })
    .eq("id", subscriber.id)
    .eq("organization_id", subscriber.organization_id)
    .is("user_id", null)
    .select("id")
    .single();
  if (linkError) {
    const cleanedUp = await removeProvisionedUser(data.user.id);
    return { error: rollbackMessage(cleanedUp, "Could not link the subscriber login.") };
  }
  const { error: auditError } = await admin.from("audit_events").insert({
    organization_id: subscriber.organization_id,
    actor_id: actor.userId,
    action: "subscriber.credentials.created",
    entity_type: "subscriber",
    entity_id: subscriber.id,
  });
  if (auditError) {
    const cleanedUp = await removeProvisionedUser(data.user.id, subscriber.id);
    return { error: rollbackMessage(cleanedUp, "Could not record the security audit.") };
  }

  revalidatePath("/admin/access");
  return { success: `Login created for ${subscriber.account_number}.` };
}

export async function resetSubscriberPassword(
  input: unknown,
): Promise<ActionResult> {
  const actor = await requireMembership("/operations/sign-in");
  if (actor.role !== "admin" && actor.role !== "staff") {
    return { error: "You do not have permission to reset subscriber passwords." };
  }
  const parsed = z
    .object({
      subscriber_id: z.uuid(),
      password: passwordSchema,
      confirm_password: z.string(),
    })
    .refine((value) => value.password === value.confirm_password, {
      message: "Passwords do not match.",
      path: ["confirm_password"],
    })
    .safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the password details." };
  }

  const { data: subscriber, error: subscriberError } = await actor.client
    .from("subscribers")
    .select("id, organization_id, account_number, user_id, status")
    .eq("id", parsed.data.subscriber_id)
    .single();
  if (subscriberError || !subscriber) {
    return { error: "Subscriber not found or inaccessible." };
  }
  if (!subscriber.user_id) {
    return { error: "That subscriber does not have a login yet." };
  }
  if (subscriber.status === "suspended") {
    return { error: "Reactivate the subscriber before resetting their password." };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: "Credential provisioning is not configured on the server." };
  }
  const { data, error } = await admin.auth.admin.updateUserById(
    subscriber.user_id,
    { password: parsed.data.password },
  );
  if (error || !data.user) {
    return { error: "Could not reset the subscriber password." };
  }

  const { error: auditError } = await admin.from("audit_events").insert({
    organization_id: subscriber.organization_id,
    actor_id: actor.userId,
    action: "subscriber.password.reset",
    entity_type: "subscriber",
    entity_id: subscriber.id,
  });
  if (auditError) {
    return {
      error:
        "Password was reset, but the security audit could not be recorded. Ask an administrator to review the audit log.",
    };
  }

  revalidatePath("/admin/access");
  return { success: `Password reset for ${subscriber.account_number}.` };
}
