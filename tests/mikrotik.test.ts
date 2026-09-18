import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { validConnectorToken, readTelemetry } from "../src/lib/mikrotik.ts";

test("connector token rejects missing, malformed and incorrect credentials", () => {
  const token = "a".repeat(43);
  const hash = createHash("sha256").update(token).digest("hex");
  assert.equal(validConnectorToken(`Bearer ${token}`, hash), true);
  for (const header of [null, token, `Bearer ${"b".repeat(43)}`, "Bearer short"]) {
    assert.equal(validConnectorToken(header, hash), false);
  }
  assert.equal(validConnectorToken(`Bearer ${token}`, ""), false);
});

test("snapshot validation rejects tenant overrides, arbitrary commands and oversized bodies", async () => {
  const snapshot = { identity: "test", version: "6.49.19", uptime: "1d", queues: [] };
  const request = (value: unknown) => new Request("https://example.com", { method: "POST", body: JSON.stringify(value) });
  assert.deepEqual(await readTelemetry(request(snapshot)), { ...snapshot, dhcpLeases: [] });

  const withLease = { ...snapshot, dhcpLeases: [{ id: "*1", address: "192.168.88.10", macAddress: "AA:BB:CC:DD:EE:FF", hostName: "cpe", server: "dhcp1", status: "bound", dynamic: true, comment: "" }] };
  assert.deepEqual(await readTelemetry(request(withLease)), withLease);
  await assert.rejects(readTelemetry(request({ ...snapshot, organization_id: "other" })));
  await assert.rejects(readTelemetry(request({ ...snapshot, command: "/system/reboot" })));
  await assert.rejects(readTelemetry(request({ ...snapshot, identity: "a".repeat(1_000_001) })));
});

test("router snapshots are read-only and restricted to active admins of the owning company", async () => {
  const db = new PGlite();
  const orgA = "00000000-0000-4000-8000-000000000001";
  const orgB = "00000000-0000-4000-8000-000000000002";
  const user = "00000000-0000-4000-8000-000000000003";
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select '${user}'::uuid$$;
      grant usage on schema auth to authenticated;
      create table public.organizations(id uuid primary key);
      create table public.memberships(user_id uuid, organization_id uuid, role text, status text);
      grant select on public.memberships to authenticated;
      insert into organizations values ('${orgA}'),('${orgB}');
      insert into memberships values ('${user}','${orgA}','admin','active');`);
    await db.exec(await readFile(new URL("../supabase/migrations/20260917003146_mikrotik_telemetry.sql", import.meta.url), "utf8"));
    await db.exec(`insert into mikrotik_snapshots(organization_id,router_key,snapshot) values
      ('${orgA}','local-test','{}'),('${orgB}','local-test','{}'); set role authenticated;`);
    assert.deepEqual((await db.query("select organization_id from mikrotik_snapshots")).rows, [{ organization_id: orgA }]);
    await assert.rejects(db.exec("update mikrotik_snapshots set snapshot='{}'"));
    await assert.rejects(db.exec("delete from mikrotik_snapshots"));
    await assert.rejects(db.exec(`insert into mikrotik_snapshots values ('${orgA}','local-test',now(),'{}')`));
    for (const role of ["staff", "subscriber"]) {
      await db.exec(`reset role; update memberships set role='${role}'; set role authenticated;`);
      assert.equal((await db.query("select * from mikrotik_snapshots")).rows.length, 0);
    }
    await db.exec("reset role; update memberships set role='admin',status='suspended'; set role authenticated;");
    assert.equal((await db.query("select * from mikrotik_snapshots")).rows.length, 0);
    await db.exec("reset role; set role anon;");
    await assert.rejects(db.query("select * from mikrotik_snapshots"));
  } finally { await db.close(); }
});
