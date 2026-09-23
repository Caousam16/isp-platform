import { LiveWorkspace } from "@/components/live-workspace";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <LiveWorkspace allowedRoles={["admin", "staff"]} />;
}
