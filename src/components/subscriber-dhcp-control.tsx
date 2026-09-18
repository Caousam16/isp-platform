"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { linkSubscriberDhcp, syncSubscriberQueue, unlinkSubscriberQueue } from "@/app/admin/routers/actions";

type Subscriber = { id: string; name: string; account_number: string; status: string };
export function SubscriberDhcpControl({ leaseId, address, macAddress, hostName, subscribers, linked, queueName }: {
  leaseId: string; address: string; macAddress: string; hostName?: string;
  subscribers: Subscriber[]; linked?: Subscriber; queueName?: string | null;
}) {
  const [selected,setSelected] = useState("");
  const [message,setMessage] = useState("");
  const [pending,start] = useTransition();
  const router = useRouter();
  const run = (prompt:string, task:()=>Promise<{error?:string;message?:string}>) => {
    if (!window.confirm(prompt)) return;
    start(async()=>{ try { const r=await task(); setMessage(r.error ?? r.message ?? ""); router.refresh(); }
      catch { setMessage("Request failed. Refresh and try again."); } });
  };
  if (linked) return <div><strong>Linked: {linked.name}</strong> · {linked.account_number}
    <div>{queueName ? <><span>Queue: <strong>{queueName}</strong></span> <button disabled={pending} type="button" onClick={()=>run(`Apply current service plan to ${queueName}?`,()=>syncSubscriberQueue(linked.id))}>Sync plan to queue</button></> : <span>No simple queue for this DHCP IP</span>}<br/><button disabled={pending} type="button" onClick={()=>run(`Unlink ${linked.name} from DHCP ${address} (${macAddress})?`,()=>unlinkSubscriberQueue(linked.id))}>Unlink</button></div>
    <p role="status">{message}</p></div>;
  return <div><label>Subscriber for {address}
    <select value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">Choose subscriber</option>
      {subscribers.map(s=><option key={s.id} value={s.id}>{s.name} · {s.account_number}</option>)}
    </select></label>
    <button disabled={pending || !selected || !macAddress} type="button" onClick={()=>run(
      `Link ${subscribers.find(s=>s.id===selected)?.name} to MikroTik DHCP ${address} / ${macAddress}${hostName ? ` / ${hostName}` : ""}?`,
      ()=>linkSubscriberDhcp({subscriberId:selected,leaseId}))}>Link ONU</button>
    <p role="status">{message}</p></div>;
}
