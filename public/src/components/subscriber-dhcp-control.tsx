"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { linkSubscriberDhcp, syncSubscriberQueue, unlinkSubscriberQueue } from "@/app/admin/routers/actions";

type Subscriber = { id: string; name: string; account_number: string; status: string };
export function SubscriberDhcpControl({ routerKey, leaseId, address, macAddress, hostName, subscribers, linked, queueName }: {
  routerKey: string; leaseId: string; address: string; macAddress: string; hostName?: string;
  subscribers: Subscriber[]; linked?: Subscriber; queueName?: string | null;
}) {
  const [selected,setSelected] = useState("");
  const [message,setMessage] = useState("");
  const [pending,start] = useTransition();
  const router = useRouter();
  const chosen=subscribers.find(s=>s.account_number===selected);
  const run = (prompt:string, task:()=>Promise<{error?:string;message?:string}>) => {
    if (!window.confirm(prompt)) return;
    start(async()=>{ try { const r=await task(); setMessage(r.error ?? r.message ?? ""); router.refresh(); }
      catch { setMessage("Request failed. Refresh and try again."); } });
  };
  if (linked) return <div><strong>Linked: {linked.name}</strong> · {linked.account_number}
    <div>{queueName ? <><span>Queue: <strong>{queueName}</strong></span> <button disabled={pending} type="button" onClick={()=>run(`Apply current service plan to ${queueName}?`,()=>syncSubscriberQueue(linked.id))}>Sync plan to queue</button></> : <span>No simple queue for this DHCP IP</span>}<br/><button disabled={pending} type="button" onClick={()=>run(`Unlink ${linked.name} from DHCP ${address} (${macAddress})?`,()=>unlinkSubscriberQueue(linked.id))}>Unlink</button></div>
    <p role="status">{message}</p></div>;
  return <div><label>Subscriber for {address}
<input list={`subscribers-${routerKey}`} value={selected} onChange={e=>setSelected(e.target.value)} placeholder="Account number" /></label>
    <button disabled={pending || !chosen || !macAddress} type="button" onClick={()=>run(
      `Link ${chosen?.name} to MikroTik DHCP ${address} / ${macAddress}${hostName ? ` / ${hostName}` : ""}?`,
      ()=>linkSubscriberDhcp({subscriberId:chosen!.id,leaseId,routerKey}))}>Link ONU</button>
    <p role="status">{message}</p></div>;
}
