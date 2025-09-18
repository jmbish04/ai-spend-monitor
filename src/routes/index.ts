import { Hono } from 'hono';
import type { Context } from 'hono';
import { loadConfig } from '../env';
import type { RuntimeBindings } from '../env';
import { RawPageStore } from '../core/storage';
import type { RollupResponse } from '../core/storage';
import { requireAdmin } from '../core/auth';
import { dispatchCapAlerts } from '../core/alerts';
import type { ProviderName, ProviderRawPage, SpendRow } from '../core/types';
import { openAiRowsFromRaw } from '../providers/openai';
import { anthropicRowsFromRaw } from '../providers/anthropic';
import { vertexBudgetRowsFromRaw } from '../providers/gcp_billing';
import { vertexBigQueryRowsFromRaw } from '../providers/gcp_bigquery';

const providers: ProviderName[] = ['openai', 'anthropic', 'vertex'];

const isProviderName = (value: string): value is ProviderName =>
  (providers as string[]).includes(value);

const getConfig = (c: Context) =>
  loadConfig(c.env as unknown as Record<string, unknown> & Partial<RuntimeBindings>);

const getRollupStub = (c: Context) => {
  const config = getConfig(c);
  const id = config.ROLLUP_DO.idFromName('global');
  return { config, stub: config.ROLLUP_DO.get(id) };
};

const serializeRowsFromRaw = (pages: ProviderRawPage[]): SpendRow[] => {
  const grouped = pages.reduce<Record<ProviderName, ProviderRawPage[]>>(
    (acc, page) => {
      acc[page.provider] = acc[page.provider] ?? [];
      acc[page.provider].push(page);
      return acc;
    },
    { openai: [], anthropic: [], vertex: [] },
  );
  const rows: SpendRow[] = [];
  if (grouped.openai.length) {
    rows.push(...openAiRowsFromRaw(grouped.openai));
  }
  if (grouped.anthropic.length) {
    rows.push(...anthropicRowsFromRaw(grouped.anthropic));
  }
  if (grouped.vertex.length) {
    const budgetPages = grouped.vertex.filter((page) => page.meta?.endpoint === 'budgets');
    const bigQueryPages = grouped.vertex.filter((page) => page.meta?.endpoint === 'bigquery');
    if (budgetPages.length) {
      rows.push(...vertexBudgetRowsFromRaw(budgetPages as ProviderRawPage[]));
    }
    if (bigQueryPages.length) {
      rows.push(...vertexBigQueryRowsFromRaw(bigQueryPages as ProviderRawPage[]));
    }
  }
  return rows;
};

export const createApp = () => {
  const app = new Hono();

  app.get('/status', async (c) => {
    const { config, stub } = getRollupStub(c);
    const response = await stub.fetch('https://rollup/state');
    const state = response.ok ? ((await response.json()) as RollupResponse) : undefined;
    return c.json({
      ok: true,
      bindings: {
        hasRawPages: Boolean(config.RAW_PAGES),
        hasRollup: Boolean(config.ROLLUP_DO),
      },
      lastRun: state?.lastRun ?? null,
      lastError: state?.lastError ?? null,
      providersEnabled: config.flags,
    });
  });

  app.get('/spend', async (c) => {
    const { stub } = getRollupStub(c);
    const url = new URL('https://rollup/spend');
    for (const [key, values] of Object.entries(c.req.queries())) {
      const value = values.at(-1);
      if (value) {
        url.searchParams.set(key, value);
      }
    }
    const response = await stub.fetch(url.toString());
    if (!response.ok) {
      return c.json({ ok: false, status: response.status }, response.status as any);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return c.json(payload);
  });

  app.post('/test/alert', async (c) => {
    const config = getConfig(c);
    if (!config.slackWebhook && !config.emailWebhook && !config.hardCapWebhook) {
      return c.json({ ok: false, message: 'No alert channels configured' }, { status: 400 });
    }
    const now = new Date();
    const result = await dispatchCapAlerts(
      {
        breaches: [
          {
            scope: 'global',
            level: 'soft',
            threshold: 1,
            total: 1,
            triggeredAt: now.toISOString(),
          },
        ],
        totals: { global: 1, openai: 0, anthropic: 0, vertex: 0 },
      },
      {
        channels: { slackWebhook: config.slackWebhook, emailWebhook: config.emailWebhook },
        hardCapWebhook: config.hardCapWebhook,
        lastSent: {},
      },
      now,
    );
    return c.json({ ok: true, results: result.results });
  });

  app.get('/config', (c) => {
    const config = getConfig(c);
    return c.json({
      flags: config.flags,
      caps: config.caps,
      cronLookbackHours: config.cronLookbackHours,
      providers: {
        openai: Boolean(config.openai.apiKey),
        anthropic: Boolean(config.anthropic.apiKey),
        vertexBillingApi: config.flags.vertexBillingApi,
        vertexBigQuery: config.flags.vertexBigQuery,
      },
    });
  });

  app.get('/providers/:name/raw', async (c) => {
    const name = c.req.param('name');
    if (!isProviderName(name)) {
      return c.json({ ok: false, message: 'Unknown provider' }, { status: 404 });
    }
    const config = getConfig(c);
    const store = new RawPageStore(config.RAW_PAGES);
    const cursor = c.req.query('cursor') ?? undefined;
    const limit = c.req.query('limit');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const list = await store.list(name, cursor, limit ? Number(limit) : undefined);
    const items = list.items.filter((item) => {
      if (from && item.window.from && item.window.from < from) return false;
      if (to && item.window.to && item.window.to > to) return false;
      return true;
    });
    return c.json({ items, cursor: list.cursor });
  });

  app.post('/admin/recompute', async (c, next) => {
    const config = getConfig(c);
    const guard = requireAdmin(config.adminToken);
    await guard(c, next);
  }, async (c) => {
    const config = getConfig(c);
    const store = new RawPageStore(config.RAW_PAGES);
    const pages = await store.getAll();
    const rows = serializeRowsFromRaw(pages);
    const { stub } = getRollupStub(c);
    const response = await stub.fetch('https://rollup/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows,
        nowIso: new Date().toISOString(),
        caps: config.caps,
        replace: true,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return c.json({ ok: false, message: text }, response.status as any);
    }
    return c.json({ ok: true, rows: rows.length });
  });

  return app;
};
