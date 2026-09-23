# Production hardening release — deployment guide

This overlay is based on Caousam16/isp-platform commit `d321fc9bf4333480f92db4dd4e080a913a782d61`. It hardens existing subscriber, billing, access and MikroTik workflows. No new product modules are included. It has not been connected to your live database or routers during preparation.

## Extracting the ZIP

Back up the current application folder, database, environment settings and connector configuration first. Stop the application and all connector processes for a coordinated maintenance window. Extract **inside your existing project/main folder**, choosing overwrite. The archive has `package.json`, `src/`, `connector/` and `supabase/` directly at its root; it does not create an extra project folder.

Local environment files, actual connector configs, certificates, command-result checkpoints, dependencies and build output are not included. Extraction preserves those existing files. Do not delete connector `.result.json` files: they prevent an interrupted router write from being replayed. Run `npm ci` and rebuild; do not reuse an old `.next` build. If you have custom code beyond the base commit, compare it before overwriting.

**File replacement alone does not apply the database migration.** The database, web application and connector must move to this release together. The old one-argument command-claim RPC and non-idempotent billing RPC permissions change.

## Database upgrade

Use a staging copy first. Review migration history in the Supabase dashboard or with `supabase migration list` against the intended project. Use your usual authenticated Supabase CLI workflow; confirm the project reference before `supabase db push`.

For an existing database already through `20260918143000_dhcp_only_subscriber_identity.sql`, apply the forward migration:

`supabase/migrations/20260922084015_production_hardening.sql`

Apply earlier missing migrations in order if your database is behind. Do not manually mark migrations applied to bypass a schema mismatch. For an empty project, apply all migrations in filename order through the CLI. Three overlapping historical migration files now have compatibility guards so the complete fresh migration chain works. Already-applied historical migrations are not rerun; the new forward migration removes the legacy direct service-update path.

Before and after the change, inspect outstanding commands:

```sql
select organization_id, router_key, status, count(*)
from public.mikrotik_bandwidth_jobs
group by organization_id, router_key, status
order by organization_id, router_key, status;
```

Finish or reconcile running/uncertain writes before cutover. Test your database backup restoration separately. A rollback after this migration requires a coordinated application/database recovery plan; restoring only the old frontend is insufficient. Preserve any payments posted after the backup and reconcile them before database restoration.

## Web configuration

Use Node.js **24.14 or later within the Node 24 release line**, npm, and Python 3.12 for the connector/tests. Set these values in the deployment's environment, never in client source:

- `NEXT_PUBLIC_SUPABASE_URL`: production Supabase HTTPS origin.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: production public key.
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`): privileged server-only key.
- `NEXT_PUBLIC_APP_URL`: exact public HTTPS origin.
- `MIKROTIK_ROUTERS_JSON`: three server-configured router scopes, shown below.

```json
[
  {"routerKey":"local-test","organizationId":"REPLACE_COMPANY_UUID_1","tokenSha256":"REPLACE_64_LOWERCASE_HEX_HASH_1"},
  {"routerKey":"router-2","organizationId":"REPLACE_COMPANY_UUID_2","tokenSha256":"REPLACE_64_LOWERCASE_HEX_HASH_2"},
  {"routerKey":"router-3","organizationId":"REPLACE_COMPANY_UUID_3","tokenSha256":"REPLACE_64_LOWERCASE_HEX_HASH_3"}
]
```

Store it as one JSON string. Keys and token hashes must be unique. Routers can share a company UUID if they serve the same company. **Keep `local-test` for an already-linked router**: existing snapshots/mappings/jobs use that key. Renaming a router key requires a planned data migration, not just changing an environment variable. The legacy `MIKROTIK_ORGANIZATION_ID` and `MIKROTIK_CONNECTOR_TOKEN_SHA256` pair remains supported when the JSON variable is unset.

Generate a different token for each router on a trusted connector host:

```sh
python3 -c "import secrets,hashlib; t=secrets.token_urlsafe(32); print('connector token:',t); print('server SHA256:',hashlib.sha256(t.encode()).hexdigest())"
```

Put the raw token only in that router's local config. Put its hash in the server environment. Requests cannot choose their own company/router scope.

```sh
npm ci
npm run check:production
npm run typecheck
npm test
npm run test:connector
npm run build
npm start
```

`check:production` validates configuration shape, not credentials or connectivity. Builds on Vercel production also run this configuration check; other hosts must explicitly run it before release. Serve the application through HTTPS with trusted proxy host forwarding. Keep Supabase public signup disabled, configure exact Auth redirect URLs, and verify account access with real staging admin, staff and subscriber users. Existing group-wide administrator access is preserved; staff remain scoped to their company and can disconnect active services, while other lifecycle actions require an administrator.

## Three routers with 1,000 subscribers each

Use automatic snapshots for all three routers. Run one connector process/config per router, with unique credentials, token, CA certificate path and result checkpoint. Start the processes at different times to spread work. The dashboard reads stored snapshots; refreshing a page does not initiate a full router read.

Copy `connector/config.example.json` to `connector/config.router-1.json` and equivalent files for the other routers. Keep your existing API-SSL certificate verification and firewall setup from `MIKROTIK-SETUP.md`. No public RouterOS API exposure is needed.

Set `interval_seconds` to **120** and `command_interval_seconds` to **10**. A full refresh follows a processed command; idle command polls do not trigger full snapshots. Errors use bounded exponential backoff and jitter. Synchronize host/router clocks. Snapshots older than six minutes cannot authorize mapped service changes. Uploads outside the accepted ten-minute past/one-minute future window are rejected.

Start with `enable_writes: false` to validate identity/mappings:

```sh
python3 connector/mikrotik_connector.py --config connector/config.router-1.json --once --diagnose
python3 connector/mikrotik_connector.py --config connector/config.router-1.json
```

Repeat for routers 2 and 3. Configure your service manager to restart each process on failure, use an unprivileged account, protect config files and keep checkpoint directories writable by that account only. The lock prevents concurrent processes using the same config path; do not duplicate a router's config under another filename to bypass it. Collection bounds are 2,000 total queues and 2,000 DHCP leases per router, with a 4 MB upload limit.

Once read-only staging checks pass, enable writes using the existing narrowly authorized RouterOS account described in `MIKROTIK-WRITES.md`. The only writer remains simple-queue bandwidth control. No arbitrary command execution, PPPoE provisioning or new network feature is added.

## Required staging acceptance

1. Confirm all three routers display independently with the expected company and recent snapshot. Verify 1,000 records per router, not only the first 500. Check representative MAC/IP/queue identities against RouterOS.
2. Verify staff cannot see another company's subscribers or directly activate/reconnect/change plans; verify a subscriber sees only their own records. Verify admin credentials and subscriber password reset using real Supabase Auth.
3. On a designated test subscriber, suspend, observe a queued command, and confirm RouterOS readback before calling the change complete. Reconnect as admin and verify the plan's rates. Test a changed queue identity and an offline/stale router: the mapped service mutation must fail rather than silently diverge.
4. Retry one invoice and one payment submission after a simulated lost response; verify only one document/allocation exists. The same open form reuses its request ID. After closing/reopening or reloading a form, reconcile existing records before submitting again; that is a new request.
5. Interrupt a connector around a test write. Confirm the saved result is acknowledged on restart without replaying the command. A command abandoned for five minutes becomes `uncertain`; inspect RouterOS and the expected/desired settings before reconciling that job. Do not delete jobs/checkpoints or blindly resend uncertain writes. Unrelated queues may continue.
6. Measure real snapshot duration, router CPU, page load time, database latency and payload size with your three routers and billing history. The synthetic tests establish correctness at 3,000 identities, not router hardware capacity or a concurrent-user SLA.

## Operational limits

Workspace data is read in database pages until complete, with a 50,000-record safety limit per collection that fails explicitly instead of returning misleading partial totals. Rendering uses 100-row pages; router DHCP tables use 50-row pages and one shared subscriber picker per router. Search/totals/export still operate on all loaded workspace data, so large billing histories need monitoring. This release does not introduce a new server-side search/reporting architecture. Audit history remains the most recent 50 events.

Service state is administrative intent; a queued job is not proof of applied bandwidth. Always check command status and router readback. Unmapped services retain their existing database-only behavior. DHCP identity linking and later service synchronization remain separate explicit operations. Automatic snapshots update observed network identity, not billing records.
