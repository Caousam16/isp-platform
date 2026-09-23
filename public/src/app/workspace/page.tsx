import { landingForRole, requireMembership } from "@/lib/access";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function WorkspacePage() {
  const { role } = await requireMembership();
  redirect(landingForRole(role));
}
