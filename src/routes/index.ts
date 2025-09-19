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
import { SpendDatabase } from '../core/database';
import { formatUtcDate } from '../core/rollups';

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

  app.get('/', (c) => {
    const today = new Date();
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const defaultFrom = formatUtcDate(startOfMonth);
    const defaultTo = formatUtcDate(today);
    const html = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Spend Monitor</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 1.5rem; background: radial-gradient(circle at top, #0f172a, #020617); color: #f8fafc; }
      h1 { margin-top: 0; font-size: 2rem; }
      .card { background: rgba(15, 23, 42, 0.75); border-radius: 16px; padding: 1.5rem; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.4); }
      label { display: block; margin-bottom: 0.5rem; font-weight: 600; }
      input[type="date"] { border: none; padding: 0.5rem 0.75rem; border-radius: 8px; background: rgba(248, 250, 252, 0.1); color: inherit; }
      button { margin-top: 1rem; padding: 0.6rem 1.2rem; border-radius: 999px; border: none; background: linear-gradient(120deg, #6366f1, #8b5cf6); color: white; font-weight: 600; cursor: pointer; box-shadow: 0 10px 24px rgba(99, 102, 241, 0.35); }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .totals { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
      .totals div { background: rgba(15, 23, 42, 0.65); padding: 0.9rem 1rem; border-radius: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
      th, td { padding: 0.75rem 0.5rem; border-bottom: 1px solid rgba(148, 163, 184, 0.2); text-align: left; }
      th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; color: #94a3b8; }
      td { font-size: 0.95rem; }
      .range { display: flex; flex-wrap: wrap; gap: 1rem; }
      .range > div { flex: 1 1 160px; }
      @media (max-width: 640px) {
        .card { padding: 1.1rem; }
        table { font-size: 0.85rem; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>AI Spend Monitor</h1>
      <p style="color:#cbd5f5; margin-top:0.25rem;">Track spend across providers. Select a custom range to explore historic usage.</p>
      <form id="range-form">
        <div class="range">
          <div>
            <label for="from">From</label>
            <input type="date" id="from" name="from" value="${defaultFrom}" max="${defaultTo}" required />
          </div>
          <div>
            <label for="to">To</label>
            <input type="date" id="to" name="to" value="${defaultTo}" max="${defaultTo}" required />
          </div>
        </div>
        <button type="submit">Update</button>
      </form>
      <div class="totals" id="totals">
        <div id="summary-total">Current range total: —</div>
        <div id="summary-providers"></div>
      </div>
      <table id="daily-table" hidden>
        <thead>
          <tr>
            <th>Date</th>
            <th>Total USD</th>
            <th>OpenAI</th>
            <th>Anthropic</th>
            <th>Vertex</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <script>
      const form = document.getElementById('range-form');
      const summaryTotal = document.getElementById('summary-total');
      const summaryProviders = document.getElementById('summary-providers');
      const table = document.getElementById('daily-table');
      const tbody = table.querySelector('tbody');

      async function loadSummary(from, to) {
        summaryTotal.textContent = 'Loading…';
        summaryProviders.textContent = '';
        table.hidden = true;
        tbody.innerHTML = '';
        try {
          const response = await fetch('/analytics/spend?from=' + from + '&to=' + to);
          if (!response.ok) throw new Error('Failed to load spend summary');
          const payload = await response.json();
          if (!payload.ok) throw new Error(payload.message || 'Unexpected response');
          const summary = payload.summary;
          summaryTotal.textContent =
            'Total spend: $' +
            summary.totalUsd.toFixed(2) +
            ' (' +
            summary.from +
            ' → ' +
            summary.to +
            ')';
          const providerTotals = summary.providerTotals;
          summaryProviders.innerHTML =
            'OpenAI: $' +
            providerTotals.openai.toFixed(2) +
            ' · Anthropic: $' +
            providerTotals.anthropic.toFixed(2) +
            ' · Vertex: $' +
            providerTotals.vertex.toFixed(2);
          if (summary.days.length) {
            table.hidden = false;
            for (const day of summary.days) {
              const row = document.createElement('tr');
              row.innerHTML =
                '<td>' +
                day.day +
                '</td><td>$' +
                day.totalUsd.toFixed(2) +
                '</td><td>$' +
                day.providerTotals.openai.toFixed(2) +
                '</td><td>$' +
                day.providerTotals.anthropic.toFixed(2) +
                '</td><td>$' +
                day.providerTotals.vertex.toFixed(2) +
                '</td>';
              tbody.appendChild(row);
            }
          } else {
            summaryProviders.innerHTML += ' · No spend recorded in this range.';
          }
        } catch (err) {
          summaryTotal.textContent = err.message;
        }
      }

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const from = formData.get('from');
        const to = formData.get('to');
        if (from > to) {
          alert('The end date must be after the start date.');
          return;
        }
        loadSummary(from, to);
      });

      loadSummary(form.from.value, form.to.value);
    </script>
  </body>
</html>`;
    return c.html(html);
  });

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

  app.get('/analytics/spend', async (c) => {
    const config = getConfig(c);
    const today = new Date();
    const defaultFrom = formatUtcDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
    const defaultTo = formatUtcDate(today);
    const from = c.req.query('from') ?? defaultFrom;
    const to = c.req.query('to') ?? defaultTo;
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoDatePattern.test(from) || !isoDatePattern.test(to)) {
      return c.json({ ok: false, message: 'Invalid date format' }, 400);
    }
    if (from > to) {
      return c.json({ ok: false, message: 'The start date must be on or before the end date.' }, 400);
    }
    const db = new SpendDatabase(config.DB);
    const summary = await db.fetchSummary({ from, to });
    return c.json({ ok: true, summary });
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
