import type { ExecutionContext, ScheduledEvent } from '@cloudflare/workers-types';
import { loadConfig } from './env';
import { RawPageStore } from './core/storage';
import { formatUtcDate } from './core/rollups';
import { fetchOpenAISpend } from './providers/openai';
import { fetchAnthropicSpend } from './providers/anthropic';
import { fetchVertexSpendViaBudget } from './providers/gcp_billing';
import { fetchVertexSpendViaBigQuery } from './providers/gcp_bigquery';
import type { ProviderRawPage, ProviderResult, SpendRow } from './core/types';
import { SpendDatabase } from './core/database';

const log = (entry: Record<string, unknown>) => {
  console.log(JSON.stringify(entry));
};

const errorLog = (entry: Record<string, unknown>) => {
  console.error(JSON.stringify(entry));
};

const collectRows = async <T>(
  name: string,
  fetcher: () => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> => {
  const start = Date.now();
  try {
    const result = await fetcher();
    log({ level: 'info', provider: name, op: 'fetch', duration_ms: Date.now() - start, rows: result.rows.length });
    return result;
  } catch (err) {
    errorLog({ level: 'error', provider: name, op: 'fetch', message: (err as Error).message });
    throw err;
  }
};

export const handleScheduled = async (event: ScheduledEvent, env: any, ctx: ExecutionContext): Promise<void> => {
  const config = loadConfig(env);
  const now = new Date(event.scheduledTime ?? Date.now());
  const lookbackHours = config.cronLookbackHours;
  const fromDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const from = formatUtcDate(fromDate);
  const to = formatUtcDate(now);
  const rawStore = new RawPageStore(config.RAW_PAGES);
  const db = new SpendDatabase(config.DB);
  const cronStartedAt = now;
  const rows: SpendRow[] = [];
  const rawPages: ProviderRawPage[] = [];
  let persistedRows = 0;

  const recordCronRun = (status: 'success' | 'error', error?: string) => {
    const completedAt = new Date();
    ctx.waitUntil(
      db
        .recordCronRun({
          startedAt: cronStartedAt,
          completedAt,
          status,
          rowsIngested: persistedRows,
          error,
        })
        .catch((cronErr) =>
          errorLog({ level: 'error', op: 'cron-run-log', message: (cronErr as Error).message }),
        ),
    );
  };

  try {
    if (config.flags.openai && config.openai.apiKey) {
      const result = await collectRows('openai', () =>
        fetchOpenAISpend(
          {
            apiKey: config.openai.apiKey!,
            orgId: config.openai.orgId,
            projectId: config.openai.projectId,
          },
          { from, to },
        ),
      );
      rows.push(...result.rows);
      rawPages.push(...result.rawPages);
    }

    if (config.flags.anthropic && config.anthropic.apiKey) {
      const result = await collectRows('anthropic', () =>
        fetchAnthropicSpend(
          {
            apiKey: config.anthropic.apiKey!,
            orgId: config.anthropic.orgId,
          },
          { from, to },
        ),
      );
      rows.push(...result.rows);
      rawPages.push(...result.rawPages);
    }

    if (config.flags.vertexBillingApi && config.gcp.serviceAccount && config.gcp.budgetName) {
      const result = await collectRows('vertex-budgets', () =>
        fetchVertexSpendViaBudget(
          {
            serviceAccountJson: config.gcp.serviceAccount!,
            budgetName: config.gcp.budgetName!,
          },
          { from, to },
        ),
      );
      rows.push(...result.rows);
      rawPages.push(...result.rawPages);
    }

    if (config.flags.vertexBigQuery && config.gcp.serviceAccount && config.gcp.bigQueryProject) {
      const result = await collectRows('vertex-bq', () =>
        fetchVertexSpendViaBigQuery(
          {
            serviceAccountJson: config.gcp.serviceAccount!,
            projectId: config.gcp.bigQueryProject!,
            dataset: config.gcp.bigQueryDataset!,
            table: config.gcp.bigQueryTable!,
          },
          { from, to },
        ),
      );
      rows.push(...result.rows);
      rawPages.push(...result.rawPages);
    }

    await Promise.all(rawPages.map((page) => rawStore.put(page)));

    if (rows.length) {
      persistedRows = await db.recordSpend(rows, now);
      log({ level: 'info', op: 'd1-ingest', rows: persistedRows });
    }

    const doId = config.ROLLUP_DO.idFromName('global');
    const stub = config.ROLLUP_DO.get(doId);
    const payload = {
      rows,
      nowIso: now.toISOString(),
      caps: config.caps,
      channels: { slackWebhook: config.slackWebhook, emailWebhook: config.emailWebhook },
      hardCapWebhook: config.hardCapWebhook,
      lastError: null,
    };

    const response = await stub.fetch('https://rollup/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Rollup DO update failed: ${response.status} ${text}`);
    }

    log({ level: 'info', op: 'rollup-update', duration_ms: 0, rows: rows.length });
    recordCronRun('success');
  } catch (err) {
    errorLog({ level: 'error', op: 'scheduled', message: (err as Error).message });
    const doId = config.ROLLUP_DO.idFromName('global');
    const stub = config.ROLLUP_DO.get(doId);
    ctx.waitUntil(
      stub.fetch('https://rollup/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rows: [],
          nowIso: now.toISOString(),
          caps: config.caps,
          lastError: (err as Error).message,
        }),
      }),
    );
    recordCronRun('error', (err as Error).message);
    throw err;
  }
};
