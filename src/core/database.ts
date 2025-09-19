import type { ProviderName, SpendRow } from './types';

const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'vertex'];

type D1Database = import('@cloudflare/workers-types').D1Database;

type D1Result<T> = import('@cloudflare/workers-types').D1Result<T>;

type ProviderTotals = Record<ProviderName, number>;

const createEmptyTotals = (): ProviderTotals => ({ openai: 0, anthropic: 0, vertex: 0 });

export interface SpendSummaryDay {
  day: string;
  totalUsd: number;
  providerTotals: ProviderTotals;
}

export interface SpendSummary {
  from: string;
  to: string;
  totalUsd: number;
  providerTotals: ProviderTotals;
  days: SpendSummaryDay[];
}

export interface CronRunRecord {
  startedAt: Date;
  completedAt: Date;
  status: 'success' | 'error';
  rowsIngested: number;
  error?: string;
}

export interface SpendIngestOptions {
  billingSourceId?: number;
  hookId?: number;
}

export class SpendDatabase {
  constructor(private readonly db?: D1Database) {}

  private static toCents(value: number): number {
    return Math.round(value * 100);
  }

  private static toUsd(value: number): number {
    return Number((value / 100).toFixed(2));
  }

  async recordCronRun(entry: CronRunRecord): Promise<void> {
    const db = this.db;
    if (!db) {
      return;
    }

    await db
      .prepare(
        `INSERT INTO cron_runs (run_started_at, run_completed_at, status, rows_ingested, error)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        entry.startedAt.toISOString(),
        entry.completedAt.toISOString(),
        entry.status,
        entry.rowsIngested,
        entry.error ?? null,
      )
      .run();
  }

  async recordSpend(rows: SpendRow[], capturedAt: Date, options: SpendIngestOptions = {}): Promise<number> {
    if (!rows.length) return 0;
    const db = this.db;
    if (!db) {
      return rows.length;
    }
    const capturedIso = capturedAt.toISOString();
    const statements = rows.map((row) =>
      db
        .prepare(
          `INSERT INTO spend_snapshots (
             provider, model, day, source, cost_usd_cents, input_tokens, output_tokens,
             billing_source_id, hook_id, captured_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'), datetime('now'))
           ON CONFLICT(provider, model, day, source)
           DO UPDATE SET
             cost_usd_cents = excluded.cost_usd_cents,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             billing_source_id = COALESCE(excluded.billing_source_id, spend_snapshots.billing_source_id),
             hook_id = COALESCE(excluded.hook_id, spend_snapshots.hook_id),
             captured_at = excluded.captured_at,
             updated_at = datetime('now')`,
        )
        .bind(
          row.provider,
          row.model ?? null,
          row.day,
          row.source,
          SpendDatabase.toCents(row.cost_usd),
          row.input_tokens ?? null,
          row.output_tokens ?? null,
          options.billingSourceId ?? null,
          options.hookId ?? null,
          capturedIso,
        ),
    );

    await db.batch(statements);
    return rows.length;
  }

  async fetchSummary(range: { from: string; to: string }): Promise<SpendSummary> {
    const db = this.db;
    if (!db) {
      return {
        from: range.from,
        to: range.to,
        totalUsd: 0,
        providerTotals: createEmptyTotals(),
        days: [],
      };
    }

    const statement = db
      .prepare(
        `SELECT day, provider, SUM(cost_usd_cents) AS total_cents
         FROM spend_snapshots
         WHERE day BETWEEN ?1 AND ?2
         GROUP BY day, provider
         ORDER BY day ASC, provider ASC`,
      )
      .bind(range.from, range.to);

    const result = (await statement.all<{ day: string; provider: ProviderName; total_cents: number }>()) as D1Result<{
      day: string;
      provider: ProviderName;
      total_cents: number;
    }>;

    const providerTotals = createEmptyTotals();
    const days = new Map<string, SpendSummaryDay>();
    let totalCents = 0;

    for (const row of result.results ?? []) {
      if (!PROVIDERS.includes(row.provider)) {
        continue;
      }
      const usd = SpendDatabase.toUsd(row.total_cents);
      totalCents += row.total_cents;
      const day = days.get(row.day) ?? {
        day: row.day,
        totalUsd: 0,
        providerTotals: createEmptyTotals(),
      };
      day.totalUsd = Number((day.totalUsd + usd).toFixed(2));
      day.providerTotals[row.provider] = Number(
        (day.providerTotals[row.provider] + usd).toFixed(2),
      );
      days.set(row.day, day);
      providerTotals[row.provider] = Number((providerTotals[row.provider] + usd).toFixed(2));
    }

    const orderedDays = Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day));

    return {
      from: range.from,
      to: range.to,
      totalUsd: SpendDatabase.toUsd(totalCents),
      providerTotals,
      days: orderedDays,
    };
  }
}
