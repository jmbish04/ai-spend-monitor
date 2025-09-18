# AI Spend Monitor Worker

A production-ready Cloudflare Worker that monitors AI usage and cost across OpenAI, Anthropic, and Google Vertex AI. The worker periodically ingests provider telemetry, normalises spend records, persists raw pages to KV, maintains rollups in a Durable Object, enforces per-provider and global spend caps, and emits alerts via Slack, email, and optional hard-cap webhooks.

## Features

- **Providers**
  - OpenAI usage and cost ingestion with per-model/day aggregation.
  - Anthropic Usage & Cost Admin API integration.
  - Google Vertex AI spend via Cloud Billing Budgets API and/or BigQuery billing export (feature flags).
- **Storage & scheduling**
  - Hourly cron fetch (configurable lookback window).
  - Raw API pages persisted to Workers KV (90-day TTL) for auditability.
  - Durable Object rollups for atomic aggregation, cap evaluation, and alert debouncing.
- **Cap enforcement**
  - Per-provider and global soft/hard caps defined via environment variables.
  - Slack + email notifications with one-hour debounce.
  - Optional hard-cap webhook callback for external key revocation workflows.
- **API surface (Hono)**
  - `GET /status` – health and last ingest metadata.
  - `GET /spend` – consolidated spend grouped by provider/model/day.
  - `GET /providers/:name/raw` – paginated raw API responses with optional date filters.
  - `POST /test/alert` – trigger test notifications.
  - `POST /admin/recompute` – recompute rollups from KV raw pages (Bearer token protected).
  - `GET /config` – redacted runtime configuration snapshot.
- **Alerting** – Slack webhook, generic email webhook, and optional hard-cap webhook.
- **Testing** – Vitest unit coverage for provider fetchers, cap logic, and cron orchestration.

## Getting started

### Prerequisites

- Node.js 18+
- `wrangler` CLI (installed via devDependencies)
- Cloudflare account with Workers, KV, and Durable Objects access

### Installation

```bash
npm install
```

### Configuration

Copy `wrangler.toml` and update bindings/IDs for your environment.

Configure the following secrets / variables (via `wrangler secret put` / `wrangler kv:namespace create`):

| Variable | Description |
| --- | --- |
| `RAW_PAGES` | KV namespace used for raw provider payloads |
| `ROLLUP_DO` | Durable Object binding (class: `RollupDO`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_ORG_ID` | Optional OpenAI org id |
| `OPENAI_PROJECT_ID` | Optional OpenAI project id filter |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_ORG_ID` | Optional Anthropic org id |
| `GCP_SA_JSON` | Google service account JSON (stringified) |
| `GCP_BUDGET_NAME` | Budget resource path (`projects/*/billingAccounts/*/budgets/*`) |
| `GCP_BQ_PROJECT` / `GCP_BQ_DATASET` / `GCP_BQ_TABLE` | BigQuery billing export identifiers |
| `GCP_BILLING_ACCOUNT_ID` | Optional billing account reference |
| `ADMIN_TOKEN` | Bearer token protecting admin routes |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook (optional) |
| `ALERT_EMAIL_WEBHOOK` | Generic POST webhook for email alerts (optional) |
| `ON_HARDCAP_WEBHOOK` | Hard cap webhook (optional) |
| `*_SOFT_CAP` / `*_HARD_CAP` | USD cap thresholds for OpenAI, Anthropic, Vertex, and global |
| `ENABLE_*` | Feature flags controlling providers |
| `CRON_LOOKBACK_HOURS` | Lookback window (default 48) |

### Provider-specific setup

#### OpenAI

Grant the API key access to the target organisation/project. The worker uses the Usage and Cost APIs with UTC date windows.

#### Anthropic

Ensure the API key has Usage & Cost Admin API permissions. Set `ANTHROPIC_ORG_ID` if required by your tenant.

#### Google Vertex AI

Two ingestion paths are supported (individually toggleable):

1. **Budgets API** – create a Cloud Billing budget scoped to Vertex AI SKUs. Grant the service account `Billing Account Viewer` and `Budget Viewer`. Provide `GCP_BUDGET_NAME` and billing account id.
2. **BigQuery export** – enable the detailed billing export, target dataset/table, and grant the service account `BigQuery Job User` plus dataset read access. The worker issues parameterised SQL restricted to SKUs prefixed with "Vertex AI".

### Running locally

```bash
npm run dev
```

This starts `wrangler dev` with the configured bindings. Use `wrangler dev --persist-to=./data` to simulate KV/DO persistence.

### Scheduled ingestion

The worker registers an hourly cron (`crons = ["0 * * * *"]`). Each run:

1. Fetches provider spend for the configured lookback window (48h by default).
2. Stores each provider response in KV (TTL 90 days).
3. Sends normalised rows to the Durable Object for aggregation + cap checks.
4. Triggers alerts if caps are breached (with one-hour debounce).

### API examples

Fetch global spend grouped by provider for the past week:

```bash
curl "https://<worker-host>/spend?from=2024-01-01&to=2024-01-07&groupBy=provider"
```

Inspect raw OpenAI usage pages:

```bash
curl "https://<worker-host>/providers/openai/raw?limit=10"
```

Trigger a test alert:

```bash
curl -X POST "https://<worker-host>/test/alert"
```

Recompute rollups from KV (requires `ADMIN_TOKEN`):

```bash
curl -X POST "https://<worker-host>/admin/recompute" -H "Authorization: Bearer <token>"
```

### Testing

```bash
npm test
```

### Deployment

Perform a dry-run deployment to validate bindings:

```bash
npm run deploy:dry
```

Then publish with `wrangler deploy` once configuration is complete.

## Observability & logging

The worker emits structured JSON logs for provider fetch duration, rollup updates, and error paths. Ensure log ingestion parses JSON for effective monitoring.

## Security considerations

- All secrets and tokens are sourced from environment bindings – never hard-coded.
- Admin endpoints require a bearer token (`ADMIN_TOKEN`).
- Responses intentionally redact secret values.
- KV entries expire automatically after 90 days to enforce data retention.

## License

MIT
