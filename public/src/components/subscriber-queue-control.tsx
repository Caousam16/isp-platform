"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncSubscriberQueue, linkSubscriberQueue, unlinkSubscriberQueue } from "@/app/admin/routers/actions";
type Subscriber = { id: string; name: string; account_number: string; plan: string; download: number; upload: number; status: string };
export function SubscriberQueueControl({queueId,name,target,subscribers,linked,mappingMismatch}: {
  queueId: string; name: string; target: string; subscribers: Subscriber[]; linked?: Subscriber; mappingMismatch?: boolean;
}) {
  const [selected,setSelected] = useState("");
  const [message,setMessage] = useState("");
  const [pending,start] = useTransition();
  const router = useRouter();
  const submit = (prompt: string, task: () => Promise<{error?:string;message?:string}>) => {
    if (!window.confirm(prompt)) return;
    start(async () => {
      try { const result = await task(); setMessage(result.error ?? result.message ?? ""); router.refresh(); }
      catch { setMessage("Request failed. Refresh this page before trying again."); }
    });
  };
  if (linked) return <div>
    <strong>Linked: {linked.name}</strong> · {linked.plan} ({linked.download}/{linked.upload} Mbps) · {linked.status}
    {mappingMismatch && <p role="alert">Queue name or IP changed since linking. Unlink and verify before synchronizing the service.</p>}
    <div><button disabled={pending || mappingMismatch} type="button" onClick={() => submit(
      `Sync ${linked.name}'s current service state to ${name} (${target})? Confirm this IP belongs to the subscriber. Active uses the plan speeds; suspended or terminated uses the 1k restriction.`,
      () => syncSubscriberQueue(linked.id))}>Sync current service</button>
    <button disabled={pending} type="button" onClick={() => submit(`Unlink ${linked.name} from ${name}? Router speeds will not change.`,
      () => unlinkSubscriberQueue(linked.id))}>Unlink</button></div><p role="status">{message}</p>
  </div>;
  return <div><label>Test subscriber for {target}
    <select value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a subscriber with this IP</option>
      {subscribers.map(sub => <option key={sub.id} value={sub.id}>
        {sub.name} · {sub.account_number} · {sub.plan} ({sub.download}/{sub.upload} Mbps)
      </option>)}
    </select></label>
    <button type="button" disabled={pending || !selected} onClick={() => submit(
      `Confirm ${subscribers.find(sub => sub.id === selected)?.name} uses ${target} on ${name}?`,
      () => linkSubscriberQueue({subscriberId:selected,queueId}))}>Link subscriber</button><p role="status">{message}</p>
  </div>;
}
