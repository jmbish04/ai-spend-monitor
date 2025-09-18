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
