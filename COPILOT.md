# from your project root (the local clone tied to origin)
mkdir -p .agents

# CHANGE THIS: path to the folder you want to upload
SRC="/path/to/your/local/folder"

# Optional: give it a clean name inside .agents
DEST_NAME="$(basename "$SRC")"

# Copy the folder into .agents/
rsync -a --delete "$SRC"/ ".agents/$DEST_NAME"/

# Create prompt files
cat > .agents/COPILOT.md <<'EOF'
# Copilot Prompt — AI Spend Monitor Worker

You are GitHub Copilot assisting in a Cloudflare Workers TypeScript repo that monitors spend across OpenAI, Anthropic (Claude), and Google/Vertex AI.

## Coding Directives
- Target: Cloudflare Workers (workerd), TypeScript, Hono router, KV for raw pages, Durable Object for rollups/cap logic.
- Keep deps minimal; prefer native fetch/WebCrypto. Tests: Vitest + Miniflare.
- Structure:
  - /src/providers/{openai,anthropic,gcp_billing,gcp_bigquery}.ts
  - /src/core/{types,storage,caps,rollups,alerts,auth}.ts
  - /src/routes/index.ts
  - /src/cron.ts, /src/env.ts
- Expose:
  - GET /status
  - GET /spend?from&to&groupBy=provider|model|day
  - GET /providers/:name/raw?from&to
  - POST /test/alert
  - POST /admin/recompute (bearer guard)

## Implementation Notes
- Normalize to:
  interface SpendRow {
    provider: 'openai'|'anthropic'|'vertex';
    model?: string;
    day: string; // YYYY-MM-DD UTC
    input_tokens?: number;
    output_tokens?: number;
    cost_usd: number;
    currency: 'USD';
    source: 'usage_api'|'cost_api'|'bq_export'|'budgets_api';
  }
- Caps via env: OPENAI_SOFT_CAP/HARD, ANTHROPIC_*, VERTEX_*, GLOBAL_*.
- Alerts: Slack webhook + generic email webhook. Debounce 1/hr per breach type.
- Google auth: mint OAuth2 from service account JSON inside Worker (RS256).
- Tests: mock provider HTTP; verify rollups and cap logic.

## What to Prefer
- Small, pure functions. Strong typing. Exhaustive switch on provider enums.
- Helpful error messages with redacted secrets.
- Idempotent CRON run (re-runs shouldn’t duplicate rows).
EOF

cat > .agents/AGENTS.md <<'EOF'
# Agents Prompt — Orchestrator / CrewAI / LangGraph

Role: You orchestrate periodic spend ingestion, rollup, and alerting across three providers. You run in tight, observable steps with timeouts.

## Goals
1) Ingest last 48h from each provider and upsert daily SpendRow to KV.
2) Recompute month-to-date rollups in a Durable Object.
3) Evaluate caps (per-provider and global). If breached:
   - Soft: send Slack/email once per hour max.
   - Hard: POST ON_HARDCAP_WEBHOOK with a JSON payload recommending key suspension (external system decides).

## Guardrails
- Hard 55-minute max per run. Fail fast on provider 5xx with exponential backoff (max 3 attempts).
- Never log secrets; redact tokens in errors.
- If BigQuery export is enabled, prefer it over Budgets API for accuracy.

## Tasks
- task.fetch_openai
- task.fetch_anthropic
- task.fetch_vertex_budgets (feature-flag)
- task.fetch_vertex_bq (feature-flag)
- task.rollup_and_caps
- task.alerts

## Inputs (Env)
OPENAI_API_KEY, ANTHROPIC_API_KEY, GCP_SA_JSON,
GCP_BILLING_ACCOUNT_ID, GCP_BQ_PROJECT, GCP_BQ_DATASET, GCP_BQ_TABLE,
SLACK_WEBHOOK_URL, ALERT_EMAIL_WEBHOOK, ON_HARDCAP_WEBHOOK,
OPENAI_SOFT_CAP/HARD, ANTHROPIC_SOFT_CAP/HARD, VERTEX_SOFT_CAP/HARD, GLOBAL_SOFT_CAP/HARD.

## Outputs
- KV: raw pages keyed by provider+date
- DO state: month-to-date totals, last alert timestamps
- HTTP: /status, /spend, /providers/:name/raw
EOF

cat > .agents/GEMINI.md <<'EOF'
# Gemini CLI Prompt — Timeboxed Test & Spend Safety

You are Gemini running unit tests and light refactors for an AI Spend Monitor Worker. 
**Hard limits:**
- Stop all activity after **50 minutes** of wall time.
- Do not spawn nested tasks or infinite loops.
- Write at most **20 test cases** per run.

## Objectives (in order)
1) **Run Existing Tests:** Locate the `vitest` test suite and run it to establish a baseline. Report any failures immediately.

2) **Generate New Tests:** Write new test cases (`.test.ts` files) focusing on core logic and edge cases. Prioritize:
   - **Cap Logic (`/src/core/caps.ts`):**
     - A cost *at* the soft cap (should not trigger alert).
     - A cost *just over* the soft cap (should trigger alert).
     - A cost *at* the hard cap (should trigger hard cap webhook).
     - Global cap scenarios vs. provider-specific caps.
   - **Rollup Logic (`/src/core/rollups.ts`):**
     - Test idempotency: running rollup twice with the same data results in the same final state.
     - Test aggregation with multiple `SpendRow` entries for the same day.
   - **Google Auth (`/src/providers/gcp_billing.ts`):**
     - Mock the WebCrypto API to verify the RS256 JWT generation for a given service account JSON.
     - Test error handling for malformed `GCP_SA_JSON`.
   - **Data Normalization:**
     - Create tests that feed sample raw API responses from each provider and verify the output is a valid `SpendRow`.

3) **Suggest Light Refactors:** If all tests pass, identify and suggest changes that improve code quality without altering logic.
   - **DRYing up Code:** Look for repeated `fetch` patterns or data transformations across providers.
   - **Improving Type Safety:** Add more specific types or use `zod` for parsing environment variables and API responses.
   - **Readability:** Add JSDoc comments to public functions and complex logic blocks.

## What to Avoid
- **Do NOT modify production configuration** or files outside the `/src` and test directories.
- **Do NOT change business logic** (e.g., how caps are calculated) without first writing a failing test that your change then makes pass.
- **Do NOT add new, heavy dependencies** to `package.json`.
EOF
