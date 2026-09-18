import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { planSettings, restrictedSettings, planSpeedSchema } from "../src/lib/mikrotik-bandwidth.ts";

test("bandwidth input bounds and upload/download ordering", () => {
  assert.equal(planSettings(30, 10).maxLimit, "10000000/30000000");
  assert.equal(planSettings(30, 10).limitAt, "10000000/30000000");
  assert.equal(planSettings(30, 10).burstLimit, "20000000/40000000");
  assert.equal(planSettings(30, 10).burstThreshold, "20000000/40000000");
  assert.equal(planSettings(30, 10).burstTime, "8s/8s");
  assert.deepEqual(restrictedSettings(), {maxLimit:"1000/1000",limitAt:"1000/1000",burstLimit:"1000/1000",burstThreshold:"1000/1000",burstTime:"0s/0s"});
  for (const speed of [0, -1, 1.5, 100001, Infinity, NaN])
    assert.equal(planSpeedSchema.safeParse({download: speed, upload: 10}).success, false);
});

test("job isolation, exclusive claim, expiry, revoked admin and no automatic replay", async () => {
  const db = new PGlite();
  const org = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const user = "00000000-0000-4000-8000-000000000003";
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select '${user}'::uuid$$;
      grant usage on schema auth to authenticated, service_role;
      create table public.organizations(id uuid primary key);
      create table public.memberships(user_id uuid, organization_id uuid, role text, status text);
      grant select on memberships to authenticated, service_role;
      insert into auth.users values ('${user}');
      insert into organizations values ('${org}'),('${other}');
      insert into memberships values ('${user}','${org}','admin','active');`);
    await db.exec(await readFile(new URL("../supabase/migrations/20260917034034_mikrotik_bandwidth_jobs.sql", import.meta.url), "utf8"));
    async function insert(queue: string, tenant = org) {
      const { rows } = await db.query<{id:string}>(`insert into mikrotik_bandwidth_jobs(organization_id,requested_by,queue_identity,expected,desired)
        values ($1,$2,$3,'{}','{}') returning id`, [tenant,user,JSON.stringify({id:queue,name:queue,target:"192.168.1.2/32"})]);
      return rows[0].id;
    }
    const first = await insert("*1");
    await insert("*2", other);
    await assert.rejects(insert("*1"));
    await db.exec("set role authenticated");
    assert.equal((await db.query("select * from mikrotik_bandwidth_jobs")).rows.length, 1);
    await assert.rejects(db.query("select * from claim_mikrotik_bandwidth_job($1)",[org]));
    await assert.rejects(db.exec("update mikrotik_bandwidth_jobs set status='applied'"));
    await assert.rejects(insert("*9"));
    await db.exec("reset role; set role anon");
    await assert.rejects(db.exec("select * from mikrotik_bandwidth_jobs"));
    await db.exec("reset role; set role service_role");
    const claim = await db.query<{id:string;lease:string}>("select * from claim_mikrotik_bandwidth_job($1)",[org]);
    assert.equal(claim.rows[0].id, first);
    assert.ok(claim.rows[0].lease);
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length, 0);
    await db.query("update mikrotik_bandwidth_jobs set status='applied' where id=$1",[first]);
    await db.exec("reset role");
    const expired = await insert("*3");
    await db.query("update mikrotik_bandwidth_jobs set expires_at=now()-interval '1 minute' where id=$1",[expired]);
    await db.exec("set role service_role");
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length, 0);
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs where id=$1",[expired])).rows[0].status,"expired");
    await db.exec("reset role");
    const revoked = await insert("*4");
    await db.exec("update memberships set status='suspended'; set role service_role");
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length,0);
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs where id=$1",[revoked])).rows[0].status,"rejected");
    await db.exec("reset role; set role authenticated");
    assert.equal((await db.query("select * from mikrotik_bandwidth_jobs")).rows.length,0);
    for (const role of ["staff","subscriber"]) {
      await db.exec(`reset role; update memberships set role='${role}',status='active'; set role authenticated;`);
      assert.equal((await db.query("select * from mikrotik_bandwidth_jobs")).rows.length,0);
    }
  } finally { await db.close(); }
});

test("subscriber queue links require company-matched subscriber and are admin-readable only", async () => {
  const db = new PGlite();
  const org = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const user = "00000000-0000-4000-8000-000000000003";
  const subA = "00000000-0000-4000-8000-000000000004";
  const subB = "00000000-0000-4000-8000-000000000005";
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select '${user}'::uuid $$;
      grant usage on schema auth to authenticated;
      create table organizations(id uuid primary key);
      create table subscribers(id uuid,organization_id uuid, primary key(id,organization_id));
      create table memberships(user_id uuid,organization_id uuid,role text,status text);
      grant select on memberships to authenticated, service_role;
      insert into auth.users values('${user}');
      insert into organizations values('${org}'),('${other}');
      insert into subscribers values('${subA}','${org}'),('${subB}','${other}');
      insert into memberships values('${user}','${org}','admin','active');`);
    await db.exec(await readFile(new URL("../supabase/migrations/20260917034034_mikrotik_bandwidth_jobs.sql", import.meta.url),"utf8"));
    await db.query("insert into mikrotik_bandwidth_jobs(organization_id,requested_by,queue_identity,expected,desired) values ($1,$2,$3,'{}','{}')",[org,user,JSON.stringify({id:"*1",name:"JUAN 999",target:"192.168.1.2/32"})]);
    await db.exec(await readFile(new URL("../supabase/migrations/20260917071924_mikrotik_subscriber_queue_bindings.sql", import.meta.url),"utf8"));
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs")).rows[0].status,"expired");
    await db.exec("set role service_role");
    await db.query("insert into mikrotik_subscriber_queues(organization_id,subscriber_id,queue_id,queue_name,target) values ($1,$2,'*1','JUAN 999','192.168.1.2/32')",[org,subA]);
    await assert.rejects(db.query("insert into mikrotik_subscriber_queues(organization_id,subscriber_id,queue_id,queue_name,target) values ($1,$2,'*2','other','192.168.1.3/32')",[org,subB]));
    await db.exec("reset role; set role authenticated");
    assert.equal((await db.query("select * from mikrotik_subscriber_queues")).rows.length,1);
    await assert.rejects(db.exec(`delete from mikrotik_subscriber_queues where subscriber_id='${subA}'`));
    await db.exec("reset role; update memberships set role='staff'; set role authenticated");
    assert.equal((await db.query("select * from mikrotik_subscriber_queues")).rows.length,0);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("select * from mikrotik_subscriber_queues"));
  } finally { await db.close(); }
});

test("service-bound jobs require the current service, plan, queue link and active requester", async () => {
  const db = new PGlite();
  const org = "00000000-0000-4000-8000-000000000001";
  const user = "00000000-0000-4000-8000-000000000002";
  const subscriber = "00000000-0000-4000-8000-000000000003";
  const service = "00000000-0000-4000-8000-000000000004";
  const plan = "00000000-0000-4000-8000-000000000005";
  const nextPlan = "00000000-0000-4000-8000-000000000006";
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select '${user}'::uuid$$;
      grant usage on schema auth to authenticated,service_role;
      create table organizations(id uuid primary key);
      create table memberships(user_id uuid, organization_id uuid, role text, status text);
      create table subscribers(id uuid, organization_id uuid, primary key(id,organization_id));
      create table subscriber_services(id uuid primary key, organization_id uuid,subscriber_id uuid,plan_id uuid,status text);
      grant select on memberships,subscriber_services to service_role;
      insert into auth.users values ('${user}');
      insert into organizations values ('${org}');
      insert into memberships values ('${user}','${org}','staff','active');
      insert into subscribers values ('${subscriber}','${org}');
      insert into subscriber_services values ('${service}','${org}','${subscriber}','${plan}','active');`);
    await db.exec(await readFile(new URL("../supabase/migrations/20260917034034_mikrotik_bandwidth_jobs.sql", import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20260917071924_mikrotik_subscriber_queue_bindings.sql", import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20260917074037_mikrotik_service_job_roles.sql", import.meta.url),"utf8"));
    await db.query("insert into mikrotik_subscriber_queues(organization_id,subscriber_id,queue_id,queue_name,target) values ($1,$2,'*1','test','192.168.1.2/32')",[org,subscriber]);
    const identity = JSON.stringify({id:"*1",name:"test",target:"192.168.1.2/32"});
    async function job(status:string, planId=plan) {
      const result = await db.query<{id:string}>(`insert into mikrotik_bandwidth_jobs
        (organization_id,requested_by,queue_identity,expected,desired,subscriber_id,service_id,required_status,required_plan_id)
        values($1,$2,$3,'{}','{}',$4,$5,$6,$7) returning id`,[org,user,identity,subscriber,service,status,planId]);
      return result.rows[0].id;
    }
    const obsolete = await job("suspended");
    await db.exec("set role service_role");
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length,0);
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs where id=$1",[obsolete])).rows[0].status,"rejected");
    await db.exec("reset role");
    const current = await job("active");
    await db.exec("set role service_role");
    assert.equal((await db.query<{id:string}>("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows[0].id,current);
    await db.query("update mikrotik_bandwidth_jobs set status='applied' where id=$1",[current]);
    await db.exec("reset role");
    const stalePlan = await job("active",nextPlan);
    await db.exec("set role service_role");
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length,0);
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs where id=$1",[stalePlan])).rows[0].status,"rejected");
    await db.exec("reset role");
    const missingLink = await job("active");
    await db.exec("delete from mikrotik_subscriber_queues");
    await db.exec("set role service_role");
    assert.equal((await db.query("select * from claim_mikrotik_bandwidth_job($1)",[org])).rows.length,0);
    assert.equal((await db.query<{status:string}>("select status from mikrotik_bandwidth_jobs where id=$1",[missingLink])).rows[0].status,"rejected");
  } finally { await db.close(); }
});
