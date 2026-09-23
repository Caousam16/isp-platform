import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {productionDatabase} from './helpers/database.ts';
import {readAll} from '../src/lib/paged-read.ts';
import {configuredRouters,authenticateRouter,isSnapshotFresh} from '../src/lib/mikrotik-config.ts';
import {serviceLifecycleActions} from '../src/lib/domain.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const profile={maxLimit:'50000000/50000000',limitAt:'50000000/50000000',burstLimit:'60000000/60000000',burstThreshold:'60000000/60000000',burstTime:'8s/8s'};
const ip=(i:number)=>`10.1.${Math.floor(i/250)}.${i%250+1}`;
const mac=(i:number)=>`02:00:00:00:${Math.floor(i/256).toString(16).padStart(2,'0')}:${(i%256).toString(16).padStart(2,'0')}`.toUpperCase();
function snapshot(){return {collectedAt:new Date().toISOString(),identity:'Router',version:'test',uptime:'1d',dhcpLeases:Array.from({length:1000},(_,i)=>({id:`*${(i+1).toString(16)}`,address:ip(i),macAddress:mac(i),hostName:`ONU${i}`,server:'dhcp',status:'bound',dynamic:true,comment:''})),queues:Array.from({length:1000},(_,i)=>({id:`*${(i+1).toString(16)}`,name:`Queue${i}`,target:`${ip(i)}/32`,kind:'simple',parent:'none',dynamic:false,disabled:false,packetMarks:'',maxLimit:profile.maxLimit,settings:profile}))};}
test('full migration chain and three-router production invariants',async t=>{
 const db=await productionDatabase();
 const auth=async(n:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id(n)})]);await db.exec('set role authenticated');};
 const server=()=>db.exec('reset role;set role service_role');
 try{
 await db.exec(`insert into auth.users values ('${id(10)}'),('${id(11)}'),('${id(12)}'),('${id(13)}');
 insert into public.organizations(id,name) values ('${id(1)}','Load A'),('${id(2)}','Load B'),('${id(3)}','Load C');
 insert into public.memberships(user_id,organization_id,role) values ('${id(10)}','${id(1)}','admin'),('${id(11)}','${id(1)}','staff'),('${id(12)}','${id(1)}','subscriber'),('${id(13)}','${id(2)}','staff');`);
 for(let r=1;r<=3;r++){
 await db.exec(`insert into public.plans(id,organization_id,name,download_mbps,upload_mbps,price_minor,currency) values ('${id(100+r)}','${id(r)}','Fiber',50,50,59900,'PHP');`);
 const subs=[],services=[],mappings=[];
 for(let i=0;i<1000;i++){
 const sub=id(10000+r*1000+i);subs.push(`('${sub}','${id(r)}','R${r}-${i}','Subscriber ${i}','s${i}@example.com','Address','active')`);
 services.push(`('${id(30000+r*1000+i)}','${id(r)}','${sub}','${id(100+r)}','active')`);
 mappings.push(`('${id(r)}','${sub}','router-${r}','${ip(i)}','${mac(i)}')`);
 }
 await db.exec(`insert into public.subscribers(id,organization_id,account_number,name,email,address,status) values ${subs.join(',')};insert into public.subscriber_services(id,organization_id,subscriber_id,plan_id,status) values ${services.join(',')};insert into public.mikrotik_subscriber_queues(organization_id,subscriber_id,router_key,ip_address,mac_address) values ${mappings.join(',')};`);
 }
 await t.test('3000 DHCP identities refresh atomically; unchanged mappings are not rewritten',async()=>{
 await server();for(let r=1;r<=3;r++)await db.query('select public.ingest_mikrotik_snapshot($1,$2,$3,$4)',[id(r),`router-${r}`,JSON.stringify(snapshot()),new Date().toISOString()]);
 const before=await db.query('select subscriber_id,xmin::text from public.mikrotik_subscriber_queues order by subscriber_id');
 for(let r=1;r<=3;r++)await db.query('select public.ingest_mikrotik_snapshot($1,$2,$3,$4)',[id(r),`router-${r}`,JSON.stringify(snapshot()),new Date().toISOString()]);
 assert.deepEqual((await db.query('select subscriber_id,xmin::text from public.mikrotik_subscriber_queues order by subscriber_id')).rows,before.rows);
 assert.equal((await db.query<{n:number}>('select count(*)::int n from public.mikrotik_subscriber_queues where queue_id is not null')).rows[0].n,3000);
 });
 await t.test('older upload cannot replace newer snapshot',async()=>{
 await server();await db.query('select public.ingest_mikrotik_snapshot($1,$2,$3,$4)',[id(1),'router-1',JSON.stringify({...snapshot(),identity:'Old'}),new Date(Date.now()-60000).toISOString()]);
 assert.equal((await db.query<{name:string}>("select snapshot->>'identity' name from public.mikrotik_snapshots where organization_id=$1",[id(1)])).rows[0].name,'Router');
 });
 await t.test('staff can only suspend; service and router intent commit together; router claims are isolated',async()=>{
 await auth(11);
 for(const action of ['activate','reconnect','terminate','change_plan'])await assert.rejects(db.query('select public.manage_subscriber_service($1,$2,$3)',[id(31000),action,id(101)]),/Only administrators/);
 await assert.rejects(db.query("update public.subscriber_services set status='suspended' where id=$1",[id(31000)]),/permission denied/);
 await assert.rejects(db.query("select public.manage_subscriber_service($1,'suspend',null)",[id(32000)]),/permission/);
 await db.query("select public.manage_subscriber_service($1,'suspend',null)",[id(31000)]);
 await server();assert.equal((await db.query('select * from public.claim_mikrotik_bandwidth_job($1,$2)',[id(2),'router-2'])).rows.length,0);
 const job=(await db.query<{desired:typeof profile}>('select * from public.claim_mikrotik_bandwidth_job($1,$2)',[id(1),'router-1'])).rows[0];assert.equal(job.desired.maxLimit,'1000/1000');assert.equal(job.desired.burstTime,'8s/8s');
 await auth(10);await assert.rejects(db.query("select public.manage_subscriber_service($1,'reconnect',null)",[id(31000)]),/reconciliation/);
 assert.equal((await db.query<{status:string}>('select status from public.subscriber_services where id=$1',[id(31000)])).rows[0].status,'suspended');
 });
 await t.test('lost command becomes uncertain and is never replayed; other queues continue',async()=>{
 await db.exec('reset role');await db.exec("update public.mikrotik_bandwidth_jobs set started_at=now()-interval '6 minutes' where status='running'");await server();assert.equal((await db.query('select * from public.claim_mikrotik_bandwidth_job($1,$2)',[id(1),'router-1'])).rows.length,0);
 assert.equal((await db.query<{status:string}>('select status from public.mikrotik_bandwidth_jobs')).rows[0].status,'uncertain');
 await auth(11);await db.query("select public.manage_subscriber_service($1,'suspend',null)",[id(31001)]);await server();assert.equal((await db.query('select * from public.claim_mikrotik_bandwidth_job($1,$2)',[id(1),'router-1'])).rows.length,1);
 });
 await t.test('stale router prevents mapped service changes and leaves service unchanged',async()=>{
 await db.exec('reset role');await db.query("update public.mikrotik_snapshots set collected_at=now()-interval '10 minutes' where organization_id=$1",[id(2)]);
 await auth(10);await assert.rejects(db.query("select public.manage_subscriber_service($1,'suspend',null)",[id(32000)]),/snapshot is stale/);
 assert.equal((await db.query<{status:string}>('select status from public.subscriber_services where id=$1',[id(32000)])).rows[0].status,'active');
 });
 await t.test('invoice/payment retries return original records without double charging; access is rechecked',async()=>{
 await auth(11);const args=[id(11000),'2026-09-01','2026-09-30','Internet',59900,id(90001)];
 const invoice=()=>db.query<{result:{id:string}}>('select public.create_invoice($1,$2,$3,$4,$5,$6) result',args);
 const first=(await invoice()).rows[0].result;assert.deepEqual((await invoice()).rows[0].result,first);
 await assert.rejects(db.query('select public.create_invoice($1,$2,$3,$4,$5,$6)',[...args.slice(0,4),60000,id(90001)]),/different input/);
 const paymentArgs=[first.id,10000,'Cash','REF-1',id(90002)];const payment=()=>db.query('select public.post_invoice_payment($1,$2,$3,$4,$5) result',paymentArgs);
 assert.deepEqual((await payment()).rows,(await payment()).rows);
 await assert.rejects(db.query('select public.post_invoice_payment($1,$2,$3,$4)',paymentArgs.slice(0,4)),/permission denied/);
 await auth(13);await assert.rejects(invoice(),/Access denied/);await auth(12);await assert.rejects(invoice(),/Access denied/);
 });
 await t.test('anonymous users cannot ingest snapshots, claim commands or synchronize',async()=>{
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select public.claim_mikrotik_bandwidth_job($1,$2)',[id(1),'router-1']),/permission denied/);await assert.rejects(db.query('select public.sync_subscriber_router($1)',[id(11000)]),/permission denied/);await assert.rejects(db.query('select public.ingest_mikrotik_snapshot($1,$2,$3,$4)',[id(1),'router-1','{}',new Date().toISOString()]),/permission denied/);
 });
 }finally{await db.close();}
});
test('router credentials are unique and scoped; freshness and UI permissions fail closed',()=>{
 const tokens=['a'.repeat(43),'b'.repeat(43)];const scopes=tokens.map((t,i)=>({routerKey:`router-${i+1}`,organizationId:id(i+1),tokenSha256:createHash('sha256').update(t).digest('hex')}));
 const configured=configuredRouters({MIKROTIK_ROUTERS_JSON:JSON.stringify(scopes)});
 assert.equal(authenticateRouter(`Bearer ${tokens[1]}`,configured)?.routerKey,'router-2');assert.equal(authenticateRouter('Bearer '+'c'.repeat(43),configured),null);assert.throws(()=>configuredRouters({MIKROTIK_ROUTERS_JSON:JSON.stringify([scopes[0],scopes[0]])}));
 assert.equal(isSnapshotFresh('invalid'),false);assert.equal(isSnapshotFresh(new Date(Date.now()+120000).toISOString()),false);assert.equal(isSnapshotFresh(new Date().toISOString()),true);assert.deepEqual(serviceLifecycleActions('suspended','staff'),[]);assert.deepEqual(serviceLifecycleActions('active','staff'),['suspend']);
});
test('paged database reads load 3000 records even when server cap is 137; errors never return partial totals',async()=>{
 const rows=Array.from({length:3000},(_,i)=>i);assert.deepEqual((await readAll(async(from,to)=>({data:rows.slice(from,Math.min(to+1,from+137)),error:null}))).data,rows);
 assert.deepEqual((await readAll(async from=>from?{data:null,error:'failed'}:{data:[1],error:null})).data,[]);
});
