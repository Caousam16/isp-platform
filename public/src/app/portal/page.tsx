import { LiveWorkspace } from "@/components/live-workspace";

export const dynamic = "force-dynamic";

export default function SubscriberPortalPage() {
  return <LiveWorkspace allowedRoles={["subscriber"]} />;
}
