# SOUTHWOODS CABLE and Internet — ISP Platform

Start with [DEPLOYMENT.md](DEPLOYMENT.md) for this replacement release. See [RELEASE-NOTES.md](RELEASE-NOTES.md) for changes, test evidence and remaining staging checks.

## MikroTik local-router testing

The API-SSL connector supports a local RouterOS 6.49.19 router with
this app on Vercel. See [MIKROTIK-SETUP.md](MIKROTIK-SETUP.md) for setup and testing.
The admin queue inventory is at `/admin/routers`. Optional simple-queue
plan-based bandwidth and service suspension controls are documented in [MIKROTIK-WRITES.md](MIKROTIK-WRITES.md).
Mapped service changes now queue router intent in the same database transaction. Unmapped services remain database-only.

Next.js 16 + React 19 + TypeScript + Supabase, ready to import into Vercel.

This is a hardening release of the existing application. See [DEPLOYMENT.md](DEPLOYMENT.md) for the mandatory database upgrade, three-router configuration, staging checks and deployment order. Live production credentials, database and routers were not accessed while preparing this release.

### Company coverage and shared sign-in

The platform now treats **Southwoods Silang Bayan**, **Southwoods Silang Old**,
and **Southwoods Carmona** as separate company tenants under one application
domain. Existing Southwoods Silang data remains with Silang Bayan; Silang Old
starts as a clean coverage tenant. Staff and subscribers
use the existing shared sign-in routes; they do not need separate company URLs.

- An administrator has a group-wide view and can switch between all companies,
  Silang Bayan, Silang Old, and Carmona from the workspace.
- A staff membership belongs to one company. Database RLS limits that staff
  account to its company, subscribers, services, invoices, and payments.
- A subscriber sees only their own linked account within their company.
- Subscriber account numbers are globally unique because the shared subscriber
  login derives one private Auth identifier from the account number. Use company
  prefixes such as `SLI-` and `CAR-` when issuing new account numbers.
- Staff creation requires the administrator to choose a coverage company.
- Subscriber, plan, service, invoice, payment, and audit views include faceted
  search controls for status, plan, speed tier, payment method, date range,
  record type, and company-aware free-text matching.

## Run locally

Use Node.js 24.14 or later in the Node 24 release line and npm.

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. Without environment variables it opens `/demo` with synthetic records. Demo changes are held in React memory and reset on refresh. Do not enter real customer information in the public demo.

```sh
npm run typecheck
npm test
npm run build
npm start
```

## What works

| Capability                                        | Demo                                 | Configured Supabase                               |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| Dashboard, subscribers, plans, services, invoices | Synthetic data                       | Reads rows allowed by RLS                         |
| Subscriber and service search / filters           | Yes                                  | Yes, within loaded records                        |
| Add subscriber                                    | In-memory pending record             | Database insert, staff/admin only                 |
| Create plan                                       | In-memory plan                       | Database insert, admin only                       |
| Subscriber/staff/admin preview                    | Demo role selector                   | Role comes from database; no selector             |
| Invoice generation and PDF download               | In-memory sample                     | Sequential, immutable invoice + branded PDF       |
| Payment history, posting, and receipt PDFs         | In-memory sample                     | Atomic allocation + sequential receipt            |
| Subscriber contact and password update            | Session-only simulation              | Own-record RLS + Supabase Auth password update    |
| CSV export                                        | Synthetic subscriber/invoice records | Loaded records for staff/admin                    |
| Login                                             | Not needed                           | Public subscriber login; unlinked operations login |
| Role landing                                      | Demo role selector                   | `/admin` for staff/admin; `/portal` for subscriber |
| Credential provisioning                          | Not available                        | Admin creates staff; staff/admin create subscribers |
| Subscriber password reset                        | Not available                        | Staff/admin reset linked subscriber credentials   |
| Assign subscriber plans                          | In-memory pending assignment          | Staff/admin insert through RLS as pending           |
| Service lifecycle                                | In-memory state changes               | Staff suspend; admins activate, suspend, reconnect, terminate and change plan |
| Audit log                                         | Sample/session events                | Immutable subscriber, plan, and service lifecycle events |

The root redirects to `/workspace` when Supabase variables are present. Live requests never fall back to sample records on errors. `/demo` remains a separate public sample workspace, including after configuration.

## Configure Supabase

1. Use your intended Supabase project; do not assume an existing development project is production.
2. Follow the existing-database or empty-project migration path in DEPLOYMENT.md.
3. `.env.local` is intentionally excluded from the archive and source control. For a new checkout, copy `.env.example` to `.env.local` and set the project's URL and **publishable key**.
4. Add the project's `SUPABASE_SECRET_KEY` to `.env.local` and to the Vercel server environment to enable credential provisioning. A legacy `SUPABASE_SERVICE_ROLE_KEY` is also accepted. Never use a `NEXT_PUBLIC_` prefix for either privileged key.
5. In Auth settings, disable public signups, keep email/password enabled, configure a trusted site URL and exact redirect allowlist, and review Auth rate limits. There is no forgotten-password email recovery flow yet.
6. Bootstrap the first administrator as described below. Do not commit passwords, privileged keys, or actual user IDs into seed files.
7. `/login` is subscriber-only and accepts an account number plus password. It contains no staff/admin link or wording. The former `/login/staff` route is removed; `/login/subscriber` redirects to `/login` for compatibility.
8. Staff/admin use the unlinked `/operations/sign-in` route with email and password. Distribute this URL privately to the operations team.
9. Successful staff/admin sign-in opens `/admin`. Successful subscriber sign-in opens `/portal`. Database membership checks redirect anyone who reaches the wrong workspace.

### First administrator

In **Supabase Dashboard → Authentication → Users**, choose **Add user**, enter
the administrator's email and a strong password, and mark the email confirmed.
Copy the resulting Auth user UUID. Then run the following in the SQL Editor.

Use actual IDs from your own project. This template is intentionally not an automatically runnable seed.

```sql
begin;
insert into public.organizations (name, currency, timezone)
values ('SOUTHWOODS CABLE and Internet', 'PHP', 'Asia/Manila')
returning id;
-- Copy the returned organization UUID into the following statement.
insert into public.memberships (user_id, organization_id, role)
values ('AUTH_USER_UUID', 'ORGANIZATION_UUID', 'admin');
commit;
```

After the first administrator signs in at `/operations/sign-in`, open **Account credentials** from the
operations sidebar. Administrators can create staff email/password accounts.
The administrator can switch between **Staff credentials** and **Subscriber credentials**. Staff credential
creation lists every coverage company in the database, including Southwoods Silang Bayan, Southwoods
Silang Old and Southwoods Carmona after the coverage migrations are applied.
Both administrators and staff can create subscriber account-number/password
logins for subscriber records that do not yet have an Auth identity. They can
also reset the password of an active subscriber who already has a linked login.
The reset action re-reads organization ownership on the server, updates only
the linked Supabase Auth user, and records an immutable security audit event.

Subscriber provisioning automatically creates a deterministic private Auth
email alias from the normalized account number:

```text
SW-000123 → sw-000123@accounts.southwoods.invalid
```

The server creates the Auth user, assigns the same-organization `subscriber`
membership, links `subscribers.user_id`, and writes an audit event. It rolls
back a partial Auth user if database linking or auditing fails. The alias is an
internal identifier and must not be shown as the subscriber's contact email.
The browser derives it only to call Supabase password Auth; RLS authorizes the
resulting `auth.uid()`, not the entered account number.

The reserved `.invalid` address deliberately cannot receive mail. Until a secure
subscriber activation/recovery workflow is built, subscriber password creation
and administrative reset are staff-assisted. Never store plaintext passwords or application-owned
password hashes in public tables; Supabase Auth owns password hashing.

This release permits **one organization membership per Auth user**. `organization_id` and composite foreign keys prevent accidental cross-organization assignments. Multiple memberships, organization switching and branch-level restrictions are future work.

### Services and billing

Staff and administrators can open **Services → Assign plan**, select a
subscriber without a current service, and choose an internet plan. The
assignment is created with `pending` status and an audit event. RLS prevents
subscribers and cross-organization users from creating assignments. Each
subscriber can have only one non-terminated service assignment in this
foundation release.

Staff and administrators can also activate a pending service, suspend an
active service, reconnect a suspended service, terminate any current service,
or move a non-terminated service to another same-organization plan. The UI
shows only transitions valid for the recorded state. A narrowly granted RPC
locks and re-reads the service, verifies current active membership, rejects
cross-organization plans and invalid transitions, and writes the service update
and immutable audit event in one transaction. Direct client updates to
`subscriber_services` remain unavailable.

Staff and administrators can generate invoices and post a payment against one
open invoice from **Billing**. Authenticated RPCs re-read tenant-owned records,
generate organization/year-scoped document numbers, reject overpayment, and
write the immutable ledger rows and audit event atomically. Subscribers can see
their own payment history and download their invoice and receipt PDFs.

The staff/admin **Billing** area also includes a period dashboard for issued
amounts, collections, outstanding balances, overdue accounts and daily activity.
The dashboard, invoice list, payment history and CSV exports share filters for
the current month, previous month, a selected month, a custom date range or all
loaded records.

- `subscriber_services` links a subscriber to a plan within one organization.
- `invoices` stores an issued total and description.
- `payments` stores posted amounts; `payment_allocations` links payments to invoices.
- Use the organization's single configured currency throughout imports. Do not mix currencies in reports.
- Allocation inserts lock related rows and reject over-allocation.
- Issued invoices, payments, allocations and audit entries reject updates/deletes.
- The `invoice_balances` view uses `security_invoker` so caller RLS still applies.
- Opening balances, reversals, taxes, credit notes and ledger import validation still need design before real billing.

The PDF documents include the configured organization identity, subscriber,
dates, references and totals. Before production use, populate the organization
address, tax ID and contact fields and have the wording, numbering, tax fields,
retention and registration requirements reviewed for the ISP's jurisdiction.
The software does not by itself certify tax compliance.

Money is stored as integer minor units (centavos for PHP), not floating point. This is a deliberate v0.1 simplification from the roadmap's decimal-money proposal. A full plan-version/line-item model must be added before automating price changes, taxes or prorating.

## Deploy to Vercel

1. Put this folder into a private Git repository.
2. Import it in Vercel using the Next.js preset. If nested in another repository, set the root directory to this folder.
3. Use Node 22+; the included `vercel.json` configures `npm run build`.
4. Add the two Supabase public environment variables and trusted app origin independently for preview and production. Never connect arbitrary previews to the production database.
5. Deploy to a protected staging environment first, then verify password login, role routing and cross-account access with real Supabase sessions.

The included local environment file is excluded from the archive and source control. No password, service-role key, or other privileged credential is included.

## Security boundaries

- Every business table has RLS enabled and explicit grants.
- Staff can insert pending subscribers. Only administrators can insert plans.
- Browser clients cannot edit memberships, link auth identities, or directly change financial records.
- The privileged Supabase key is imported only by a `server-only` module. Every provisioning action first verifies the caller's active membership, required role, and organization.
- Administrators can create staff accounts. Administrators and staff can create subscriber accounts. Neither path can create another administrator.
- Credential creation writes an immutable audit event and attempts rollback if role assignment, subscriber linking, or auditing fails.
- Current membership status is checked in SQL, so suspension immediately blocks business-row access even with the same JWT.
- Password login creates an `aal1` session. Per the approved security model, active admin membership—not a second factor—authorizes admin access.
- `/admin` accepts only active staff/admin memberships; `/portal` accepts only active subscriber memberships. Direct URL changes redirect to the correct landing page.
- Hiding the operations login from subscriber pages improves separation but is not an authorization control; membership checks and RLS remain the security boundary.
- Subscriber access is linked to verified `auth.uid()` ownership, never a client-selected ID.
- Subscriber contact updates are limited to their own email, phone and address columns; password changes remain in Supabase Auth.
- Billing writes use authenticated RPCs with explicit staff/admin and tenant checks; raw invoice/payment mutation grants remain unavailable.
- Server Actions validate input and use the caller's session; UI visibility is not the permission boundary.
- Service lifecycle changes use an authenticated, security-invoker public RPC backed by a private security-definer function with explicit role and tenant checks. Anonymous execution and direct table updates are denied.
- CSV output quotes fields and neutralizes formula-like prefixes.
- Authenticated responses are marked private/no-store.

## Validation

`npm test` includes money/CSV/login-identifier and lifecycle-state tests plus the complete SQL migrations exercised in PGlite (embedded PostgreSQL). The database tests cover every service transition, subscriber-owned contact updates, numbered invoices and receipts, overpayment rejection, cross-tenant and subscriber denial, direct-update denial, audit metadata, role escalation, suspended membership, anonymous access, audit immutability, and derived balances.

The local database harness stubs `auth.users`, `auth.uid()` and `auth.jwt()`. It validates SQL policies and constraints; it **does not replace real Supabase Auth/SSR integration testing**. Provisioning, cookie refresh, password login and deployed RLS behavior must be verified in staging.

Creation-environment checks: TypeScript and all local tests succeeded. The sandbox lacks Node's RSS process-memory metric, so both Turbopack and webpack production builds stop before compilation with `uv_resident_set_memory`; this host limitation is not part of the project. Browser visual, responsive, and click-through QA remain unverified.

## Remaining production work

- Forgotten-password recovery, forced first-login password change, invitation acceptance, and email verification callbacks
- Session/device inventory, revocation and sensitive-action reauthentication
- Application-level activation/login abuse controls and a tested revocation policy
- Staff-side subscriber edit/archive workflows
- Plan versioning, contract/fee rules, prorating, and plan-change approvals
- Invoice line items, taxes, validated imports, reversals/credit notes, partial allocation across multiple invoices, and jurisdictional PDF approval
- Recurring billing, notification outbox, transactional email and scheduled jobs
- Storage buckets, document uploads, upload validation and retention
- Server-side search/reporting for long billing histories; this release reads complete collections in pages, bounded at 50,000 rows each, and renders 100 rows per table page
- Full permission catalog, custom roles, scoped exports and all sensitive-action audit events
- Cross-device/browser tests, real Auth integration tests, security review, backups and restore rehearsal
- Tickets, dispatch, payment gateways, network provisioning and telemetry (later phases)

The next practical milestone is **validate role-specific login, subscriber self-service, invoice/payment posting, PDF downloads and cross-account access in a protected staging environment**. Do not use this foundation as a production billing system until the jurisdictional and accounting review is complete.

## Reference guidance

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Supabase Next.js SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase password-based authentication](https://supabase.com/docs/guides/auth/passwords)
