import "server-only";
import { redirect } from "next/navigation";
import { createClient, isConfigured } from "./supabase/server";
import type { Role } from "./domain";
export async function requireMembership(loginPath = "/login") {
  if (!isConfigured()) redirect(loginPath);
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) redirect(loginPath);
  const { data: members, error: memberError } = await client
    .from("memberships")
    .select("organization_id, role, status")
    .eq("user_id", data.claims.sub)
    .eq("status", "active");
  if (memberError || !members?.length)
    redirect(`${loginPath}?reason=membership`);
  const member =
    members.find((item) => item.role === "admin") ??
    members.find((item) => item.role === "staff") ??
    members[0];
  return {
    client,
    userId: data.claims.sub,
    role: member.role as Role,
    organizationId: member.organization_id as string,
    organizationIds: members.map((item) => item.organization_id as string),
  };
}

export function landingForRole(role: Role) {
  return role === "subscriber" ? "/portal" : "/admin";
}

export async function requireRole(allowedRoles: Role[]) {
  const loginPath = allowedRoles.includes("subscriber")
    ? "/login"
    : "/operations/sign-in";
  const membership = await requireMembership(loginPath);
  if (!allowedRoles.includes(membership.role)) {
    redirect(landingForRole(membership.role));
  }
  return membership;
}
