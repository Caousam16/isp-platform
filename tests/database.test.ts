import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("foundation migration and database authorization", async (t) => {
  const db = new PGlite();
  const id = (n: number) =>
    `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const orgA = id(1),
    orgB = id(2),
    admin = id(10),
    staff = id(11),
    subA = id(12),
    subB = id(13);
  try {
    // Test-only Supabase Auth stubs. Production uses real Auth JWT validation.
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    `);
    await db.exec(`create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb, '{}'::jsonb) $$;
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid(), auth.jwt() to authenticated, anon;`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202609140001_foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260915000757_email_otp_admin_access.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260915020523_assign_subscriber_plans.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260915032100_service_lifecycle_controls.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260915090000_billing_and_subscriber_self_service.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260915170000_two_company_coverage_access.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20260916110000_split_silang_coverage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(`insert into public.organizations(id,name) values ('${orgA}','ISP A'),('${orgB}','ISP B');
      insert into auth.users values ('${admin}'),('${staff}'),('${subA}'),('${subB}');
      insert into public.memberships(user_id,organization_id,role) values ('${admin}','${orgA}','admin'),('${staff}','${orgA}','staff'),('${subA}','${orgA}','subscriber'),('${subB}','${orgB}','subscriber');
      insert into public.subscribers(id,organization_id,user_id,account_number,name,email,address,status) values ('${id(20)}','${orgA}','${subA}','TEST-A','Subscriber A','a@example.com','Area A','active'),('${id(21)}','${orgB}','${subB}','TEST-B','Subscriber B','b@example.com','Area B','active');
      insert into public.plans(id,organization_id,name,download_mbps,upload_mbps,price_minor,currency) values ('${id(30)}','${orgA}','Fiber A',100,100,10000,'PHP'),('${id(31)}','${orgB}','Fiber B',100,100,10000,'PHP');
      insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) values ('${orgA}','${id(20)}','${id(30)}','active');
      insert into public.invoices(id,organization_id,subscriber_id,number,issued_on,due_on,description,total_minor,currency) values ('${id(40)}','${orgA}','${id(20)}','INV-A','2026-09-01','2026-09-10','Service',10000,'PHP'),('${id(41)}','${orgB}','${id(21)}','INV-B','2026-09-01','2026-09-10','Service',10000,'PHP');
      insert into public.payments(id,organization_id,subscriber_id,reference,amount_minor,currency) values ('${id(50)}','${orgA}','${id(20)}','PAY-A',5000,'PHP');
      insert into public.payment_allocations(organization_id,subscriber_id,currency,invoice_id,payment_id,amount_minor) values ('${orgA}','${id(20)}','PHP','${id(40)}','${id(50)}',5000);`);
    async function asUser(user: string, aal = "aal1") {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claims',$1,false)", [
        JSON.stringify({ sub: user, aal }),
      ]);
      await db.exec("set role authenticated");
    }
    await t.test(
      "subscriber sees only own profile, invoice and plan",
      async () => {
        await asUser(subA);
        assert.equal(
          (await db.query("select * from public.subscribers")).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from public.invoice_balances")).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from public.plans")).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from public.audit_events")).rows.length,
          0,
        );
      },
    );
    await t.test("subscriber cannot create another subscriber", async () => {
      await asUser(subA);
      await assert.rejects(
        db.exec(
          `insert into public.subscribers(organization_id,account_number,name,email,address,status) values ('${orgA}','DENIED','No Access','x@example.com','Area','pending')`,
        ),
        /row-level security/,
      );
    });
    await t.test(
      "staff can create pending subscriber but cannot assign an auth identity",
      async () => {
        await asUser(staff);
        await db.exec(
          `insert into public.subscribers(organization_id,account_number,name,email,address,status) values ('${orgA}','ALLOWED','New Subscriber','n@example.com','Area','pending')`,
        );
        assert.equal(
          (await db.query("select * from public.subscribers")).rows.length,
          2,
        );
        await assert.rejects(
          db.exec(
            `insert into public.subscribers(organization_id,user_id,account_number,name,email,address,status) values ('${orgA}','${subB}','LINK-DENIED','No Access','x@example.com','Area','pending')`,
          ),
          /permission denied/,
        );
      },
    );
    await t.test(
      "staff can assign a pending plan in their organization",
      async () => {
        await asUser(staff);
        await assert.rejects(
          db.exec(
            `insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) select '${orgA}',id,'${id(30)}','active' from public.subscribers where account_number='ALLOWED'`,
          ),
          /row-level security/,
        );
        await db.exec(
          `insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) select '${orgA}',id,'${id(30)}','pending' from public.subscribers where account_number='ALLOWED'`,
        );
        await assert.rejects(
          db.exec(
            `insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) values ('${orgB}','${id(21)}','${id(31)}','pending')`,
          ),
          /row-level security/,
        );
      },
    );
    await t.test("subscriber cannot assign a plan", async () => {
      await asUser(subA);
      await assert.rejects(
        db.exec(
          `insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) values ('${orgA}','${id(20)}','${id(30)}','pending')`,
        ),
        /row-level security|duplicate key/,
      );
    });
    await t.test(
      "staff lifecycle controls enforce transitions, tenants and audit logging",
      async () => {
        await db.exec(`reset role; begin;
          insert into public.plans(id,organization_id,name,download_mbps,upload_mbps,price_minor,currency)
            values ('${id(32)}','${orgA}','Fiber A Plus',200,200,20000,'PHP');
          insert into public.subscribers(id,organization_id,account_number,name,email,address,status)
            values ('${id(22)}','${orgA}','LIFECYCLE-A','Lifecycle Test','life@example.com','Area A','pending');
          insert into public.subscriber_services(id,organization_id,subscriber_id,plan_id,status)
            values ('${id(60)}','${orgA}','${id(22)}','${id(30)}','pending');`);

        await asUser(staff);
        let savepoint = 0;
        const rejectsWithoutAborting = async (
          operation: () => Promise<unknown>,
          message: RegExp,
        ) => {
          const name = `lifecycle_${++savepoint}`;
          await db.exec(`savepoint ${name}`);
          await assert.rejects(operation(), message);
          await db.exec(`rollback to savepoint ${name}; release savepoint ${name}`);
        };
        const statusAfter = async (action: string, planId: string | null = null) => {
          const { rows } = await db.query<{ status: string }>(
            "select (public.manage_subscriber_service($1,$2,$3)).status as status",
            [id(60), action, planId],
          );
          return rows[0].status;
        };

        assert.equal(await statusAfter("activate"), "active");
        assert.equal(await statusAfter("suspend"), "suspended");
        assert.equal(await statusAfter("reconnect"), "active");
        assert.equal(await statusAfter("change_plan", id(32)), "active");
        assert.equal(await statusAfter("terminate"), "terminated");
        await rejectsWithoutAborting(
          () => statusAfter("terminate"),
          /already terminated/,
        );

        await rejectsWithoutAborting(
          () => db.exec(
            `update public.subscriber_services set status='active' where id='${id(60)}'`,
          ),
          /permission denied/,
        );

        await asUser(subA);
        await rejectsWithoutAborting(() => statusAfter("activate"), /permission/);
        await asUser(subB);
        await rejectsWithoutAborting(() => statusAfter("activate"), /permission/);

        await asUser(admin);
        const { rows: events } = await db.query<{
          action: string;
          previous_plan_id: string;
          plan_id: string;
        }>(`select action,
              metadata->>'previous_plan_id' as previous_plan_id,
              metadata->>'plan_id' as plan_id
            from public.audit_events
            where entity_id='${id(60)}'
            order by created_at`);
        assert.deepEqual(
          events.map((event) => event.action),
          [
            "subscriber_services.created",
            "subscriber_service.activate",
            "subscriber_service.suspend",
            "subscriber_service.reconnect",
            "subscriber_service.change_plan",
            "subscriber_service.terminate",
          ],
        );
        const planChange = events.find(
          (event) => event.action === "subscriber_service.change_plan",
        );
        assert.equal(planChange?.previous_plan_id, id(30));
        assert.equal(planChange?.plan_id, id(32));

        await db.exec("reset role; set role anon");
        await rejectsWithoutAborting(
          () =>
            db.query("select public.manage_subscriber_service($1,$2,$3)", [
              id(60),
              "activate",
              null,
            ]),
          /permission denied/,
        );
        await db.exec("reset role; rollback");
      },
    );
    await t.test("subscriber can update only their own contact fields", async () => {
      await asUser(subA);
      await db.exec(
        "update public.subscribers set email='new@example.com', phone='+63 917 000 0000', address='Updated Area' where user_id = auth.uid()",
      );
      const { rows } = await db.query<{ email: string; phone: string; address: string }>(
        "select email, phone, address from public.subscribers",
      );
      assert.deepEqual(rows[0], {
        email: "new@example.com",
        phone: "+63 917 000 0000",
        address: "Updated Area",
      });
      await assert.rejects(
        db.exec("update public.subscribers set name='Escalated'"),
        /permission denied/,
      );
    });
    await t.test("staff generates numbered invoices and payment receipts", async () => {
      await asUser(staff);
      const { rows: invoices } = await db.query<{ id: string; number: string }>(
        "select (public.create_invoice($1,$2,$3,$4,$5)).*",
        [id(20), "2026-09-15", "2026-09-25", "Fiber service - September", 2500],
      );
      assert.match(invoices[0].number, /^INV-2026-\d{6}$/);
      const { rows: nextInvoices } = await db.query<{ number: string }>(
        "select (public.create_invoice($1,$2,$3,$4,$5)).number",
        [id(20), "2026-09-15", "2026-09-25", "Router rental - September", 500],
      );
      assert.notEqual(nextInvoices[0].number, invoices[0].number);

      const { rows: payments } = await db.query<{ result: { payment: { receipt_number: string }; allocation: { amount_minor: number } } }>(
        "select public.post_invoice_payment($1,$2,$3,$4) as result",
        [invoices[0].id, 1500, "GCash", "TXN-001"],
      );
      assert.match(payments[0].result.payment.receipt_number, /^OR-2026-\d{6}$/);
      assert.equal(Number(payments[0].result.allocation.amount_minor), 1500);
      await assert.rejects(
        db.query("select public.post_invoice_payment($1,$2,$3,$4)", [invoices[0].id, 1001, "Cash", "TXN-002"]),
        /exceeds the invoice balance/,
      );

      await asUser(subA);
      assert.equal(
        (await db.query("select * from public.payments where reference='TXN-001'")).rows.length,
        1,
      );
      await assert.rejects(
        db.query("select public.create_invoice($1,$2,$3,$4,$5)", [id(20), "2026-09-15", "2026-09-25", "Denied invoice", 100]),
        /permission/,
      );
    });
    await t.test("staff cannot create plans or mutate roles", async () => {
      await asUser(staff);
      await assert.rejects(
        db.exec(
          `insert into public.plans(organization_id,name,download_mbps,upload_mbps,price_minor,currency) values ('${orgA}','Unauthorized',10,10,100,'PHP')`,
        ),
        /row-level security/,
      );
      await assert.rejects(
        db.exec("update public.memberships set role='admin'"),
        /permission denied/,
      );
    });
    await t.test("admin can access business data across all companies", async () => {
      await asUser(admin);
      assert.equal(
        (await db.query("select * from public.subscribers")).rows.length,
        3,
      );
      assert.equal(
        (await db.query(`select * from public.subscribers where organization_id='${orgB}'`)).rows.length,
        1,
      );
      assert.ok(
        (await db.query("select * from public.audit_events")).rows.length > 0,
      );
      assert.deepEqual(
        (
          await db.query<{ name: string }>(
            "select name from public.organizations where name like 'Southwoods %' order by name",
          )
        ).rows.map((row) => row.name),
        ["Southwoods Carmona", "Southwoods Silang Bayan", "Southwoods Silang Old"],
      );
    });
    await t.test(
      "admin can create plans in either company",
      async () => {
        await asUser(admin);
        await db.exec(
          `insert into public.plans(organization_id,name,download_mbps,upload_mbps,price_minor,currency) values ('${orgA}','New Plan',200,200,20000,'PHP')`,
        );
        await db.exec(
          `insert into public.plans(organization_id,name,download_mbps,upload_mbps,price_minor,currency) values ('${orgB}','Company B Plan',200,200,20000,'PHP')`,
        );
      },
    );
    await t.test(
      "suspension takes effect without changing the JWT",
      async () => {
        await db.exec(
          `reset role; update public.memberships set status='suspended' where user_id='${staff}'`,
        );
        await asUser(staff);
        assert.equal(
          (await db.query("select * from public.subscribers")).rows.length,
          0,
        );
      },
    );
    await t.test("anonymous cannot read business data", async () => {
      await db.exec("reset role; set role anon");
      await assert.rejects(
        db.exec("select * from public.subscribers"),
        /permission denied/,
      );
    });
    await t.test(
      "clients cannot modify financial or audit records",
      async () => {
        await asUser(admin);
        await assert.rejects(
          db.exec("delete from public.invoices"),
          /permission denied/,
        );
        await assert.rejects(
          db.exec("delete from public.audit_events"),
          /permission denied/,
        );
      },
    );
    await t.test("ledger view derives allocated balance", async () => {
      await asUser(subA);
      const { rows } = await db.query<{ paid_minor: number }>(
        "select paid_minor from public.invoice_balances",
      );
      assert.equal(Number(rows[0].paid_minor), 5000);
    });
    await t.test(
      "ledger and audit immutable even for trusted update paths",
      async () => {
        await db.exec("reset role");
        await assert.rejects(
          db.exec("update public.invoices set total_minor=1"),
          /immutable/,
        );
        await assert.rejects(
          db.exec("delete from public.audit_events"),
          /immutable/,
        );
      },
    );
    await t.test("payment over-allocation is rejected", async () => {
      await db.exec("reset role");
      await db.exec(
        `insert into public.invoices(id,organization_id,subscriber_id,number,issued_on,due_on,description,total_minor,currency) values ('${id(42)}','${orgA}','${id(20)}','INV-A2','2026-09-01','2026-09-10','Service',10000,'PHP')`,
      );
      await assert.rejects(
        db.exec(
          `insert into public.payment_allocations(organization_id,subscriber_id,currency,invoice_id,payment_id,amount_minor) values ('${orgA}','${id(20)}','PHP','${id(42)}','${id(50)}',1)`,
        ),
        /over-allocation/,
      );
    });
    await t.test("invoice over-allocation is rejected", async () => {
      await db.exec(
        `insert into public.payments(id,organization_id,subscriber_id,reference,amount_minor,currency) values ('${id(51)}','${orgA}','${id(20)}','PAY-A2',20000,'PHP')`,
      );
      await assert.rejects(
        db.exec(
          `insert into public.payment_allocations(organization_id,subscriber_id,currency,invoice_id,payment_id,amount_minor) values ('${orgA}','${id(20)}','PHP','${id(40)}','${id(51)}',5001)`,
        ),
        /over-allocation/,
      );
    });
    await t.test("cross-tenant service assignments rejected", async () => {
      await db.exec("reset role");
      await db.exec(
        `insert into public.subscribers(id,organization_id,account_number,name,email,address,status) values ('${id(23)}','${orgA}','CROSS-TEST','Cross Test','cross@example.com','Area','pending')`,
      );
      await assert.rejects(
        db.exec(
          `insert into public.subscriber_services(organization_id,subscriber_id,plan_id,status) values ('${orgA}','${id(23)}','${id(31)}','pending')`,
        ),
        /foreign key/,
      );
    });
  } finally {
    await db.close();
  }
});
