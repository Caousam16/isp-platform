# Subscriber service and MikroTik queue synchronization

The app uses an explicitly linked static simple queue for each subscriber. RouterOS rate pairs are **upload/download** from the target's perspective. Admins confirm a subscriber's /32 IP and link the queue in `/admin/routers`. A plan name cannot identify a subscriber's device; the three queues on your test router can serve only three uniquely mapped subscriber IPs.

| Current service | Max limit | Limit at | Burst limit and threshold | Burst time |
| --- | --- | --- | --- | --- |
| Active | Plan upload / download | Plan upload / download | Plan upload + 10 Mbps / download + 10 Mbps | 8s / 8s |
| Suspended or terminated | 1k / 1k | 1k / 1k | 1k / 1k | 0s / 0s |

`1k` means 1,000 bits per second. Burst time measures duration, so it is set to zero when restricted. This throttles an enabled queue; it is not a guaranteed physical disconnect. A pending service is not provisioned until activation. Plan changes on active services queue a new plan profile. Reconnection queues the current plan profile. These actions originate in the subscriber service controls; `/admin/routers` also has **Sync current service** for a mapped active or suspended service. There is no free-form speed input.

The service change is recorded in Supabase first. The router change runs later on the local connector, so **a service marked suspended in the app may still have network access until the command is applied and verified**. Check **Recent bandwidth commands** for `applied`, then inspect `/queue simple print detail` on the router. `Applied` means RouterOS read-back matched the configured queue values, not that a throughput test passed.

## Update an existing installation

1. Stop the local connector before upgrading. Deploy this app source to your existing Vercel project and apply these SQL migrations to the **same Supabase project**, in order, if not already applied:
   - `supabase/migrations/20260917034034_mikrotik_bandwidth_jobs.sql`
   - `supabase/migrations/20260917071924_mikrotik_subscriber_queue_bindings.sql`
   - `supabase/migrations/20260917074037_mikrotik_service_job_roles.sql`
2. The last migration expires pending commands from the old manual speed interface. Review any `running` or `uncertain` jobs separately; they are never replayed automatically. Existing connector credentials, token, CA certificate and Python connector files are retained if you already installed the write-enabled connector.
3. Ensure the MikroTik API user has `read,write,api` policy and the router's API-SSL source allowlist still admits only your connector PC. Set `enable_writes` to `true` in your local `connector/config.json`, and allowlist only queues whose names **and** /32 targets you confirmed belong to the linked subscriber. For example:

```json
"enable_writes": true,
"allowed_queues": {
  "JUAN 999": "192.168.1.2/32",
  "JUAN 1499": "192.168.1.4/32",
  "JUAN 599": "192.168.1.3/32"
}
```

Do not expose the connector config or router credentials. If you have not installed the write-enabled Python files from this package, replace `connector/mikrotik_connector.py` and `connector/bandwidth.py` together, keeping your local `config.json` and `router-ca.crt`.

4. From the project folder on the PC connected to the router, run `python3 connector/mikrotik_connector.py --config connector/config.json --diagnose`. Keep it running; each cycle publishes a snapshot and processes at most one queued command. For a single cycle add `--once`.
5. In `/admin/routers`, verify the queue target IP against the subscriber, link one subscriber to one queue, and sync **one test subscriber**. Check the command result and router queue before testing a service suspension, reconnection and active plan change. No live router changes were performed in this package.

The connector changes only the five simple queue bandwidth properties and checks the live queue identity and previous settings before writing. If a command is `rejected`, inspect the link, queue identity, snapshot freshness and local allowlist. If it remains `running` or becomes `uncertain`, the write may have reached the router. Compare the actual queue with the saved `before/requested` settings in command history; do not clear the local `.result.json` checkpoint or retry blindly. Restore the correct current service profile after reconciling the actual router state.

The 1k policy only covers traffic that actually passes through the mapped simple queue. Confirm device IPs, FastTrack and queue order when testing. Provisioning additional subscribers requires individual queues and verified mappings.
