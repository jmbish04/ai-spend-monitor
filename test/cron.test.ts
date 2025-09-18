import type { ExecutionContext } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { handleScheduled } from '../src/cron';

vi.mock('../src/providers/openai', () => ({
  fetchOpenAISpend: vi.fn(async () => ({
    rows: [
      { provider: 'openai', day: '2024-01-01', cost_usd: 1, currency: 'USD', source: 'usage_api' },
    ],
    rawPages: [
      {
        id: 'page-1',
        provider: 'openai',
        fetchedAt: new Date().toISOString(),
        window: { from: '2024-01-01', to: '2024-01-02' },
        payload: { data: [] },
        meta: { endpoint: 'usage' },
      },
    ],
  })),
}));

vi.mock('../src/providers/anthropic', () => ({ fetchAnthropicSpend: vi.fn(async () => ({ rows: [], rawPages: [] })) }));
vi.mock('../src/providers/gcp_billing', () => ({ fetchVertexSpendViaBudget: vi.fn(async () => ({ rows: [], rawPages: [] })) }));
vi.mock('../src/providers/gcp_bigquery', () => ({ fetchVertexSpendViaBigQuery: vi.fn(async () => ({ rows: [], rawPages: [] })) }));

const createKV = () => {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    list: vi.fn(async () => ({ keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true })),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value ? JSON.parse(value) : null;
    }),
    storage: store,
  };
};

describe('Scheduled handler', () => {
  it('stores raw pages and updates DO', async () => {
    const kv = createKV();
    const doFetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const env: any = {
      RAW_PAGES: kv,
      ROLLUP_DO: {
        idFromName: vi.fn(() => 'id'),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
      ENABLE_OPENAI: 'true',
      ENABLE_ANTHROPIC: 'false',
      ENABLE_VERTEX_BILLING_API: 'false',
      ENABLE_VERTEX_BQ: 'false',
      CRON_LOOKBACK_HOURS: '48',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_SOFT_CAP: '0',
      OPENAI_HARD_CAP: '0',
      ANTHROPIC_SOFT_CAP: '0',
      ANTHROPIC_HARD_CAP: '0',
      VERTEX_SOFT_CAP: '0',
      VERTEX_HARD_CAP: '0',
      GLOBAL_SOFT_CAP: '0',
      GLOBAL_HARD_CAP: '0',
    };

    const event: any = { scheduledTime: Date.now() };
    const ctx: ExecutionContext = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await handleScheduled(event, env, ctx);

    expect(kv.put).toHaveBeenCalled();
    expect(doFetch).toHaveBeenCalled();
    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse((init?.body as string) ?? '{}');
    expect(payload.rows).toHaveLength(1);
  });
});
