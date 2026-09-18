import { Workspace } from "@/components/workspace";
import { demoData, demoToday } from "@/lib/demo";
export default function Demo() {
  return (
    <Workspace
      initialData={demoData}
      initialRole="admin"
      mode="demo"
      today={demoToday}
    />
  );
}
