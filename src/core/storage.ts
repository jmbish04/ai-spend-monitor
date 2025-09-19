import type { DurableObjectState } from '@cloudflare/workers-types';
import type { KVNamespace } from '@cloudflare/workers-types';
import { aggregateRows, filterRowsByRange, upsertRows } from './rollups';
import { dispatchCapAlerts } from './alerts';
import { evaluateCaps } from './caps';
import type {
  AlertChannels,
  CapConfig,
  CapEvaluationResult,
  ProviderName,
  ProviderRawPage,
  SpendRow,
} from './types';

const RAW_PREFIX = 'raw';
const RETENTION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

type Cursor = string | undefined;

export interface RawPageListResult<T = unknown> {
  items: ProviderRawPage<T>[];
  cursor?: Cursor;
}

export class RawPageStore {
  constructor(private readonly kv: KVNamespace) {}

  private buildKey(provider: ProviderName, id: string): string {
    return `${RAW_PREFIX}/${provider}/${id}`;
  }

  async put(page: ProviderRawPage): Promise<void> {
    const key = this.buildKey(page.provider, page.id);
    await this.kv.put(key, JSON.stringify(page), { expirationTtl: RETENTION_TTL_SECONDS });
  }

  async list(provider: ProviderName, cursor?: Cursor, limit = 50): Promise<RawPageListResult> {
    const prefix = `${RAW_PREFIX}/${provider}/`;
    const res = await this.kv.list({ prefix, cursor, limit });
    const items: ProviderRawPage[] = [];
    for (const key of res.keys) {
      const value = await this.kv.get<ProviderRawPage>(key.name, 'json');
      if (value) {
        items.push(value);
      }
    }
    return {
      items,
      cursor: res.list_complete ? undefined : res.cursor,
    };
  }

  async getLatest(
    provider: ProviderName,
    predicate?: (page: ProviderRawPage) => boolean,
  ): Promise<ProviderRawPage | undefined> {
    let cursor: string | undefined;
    let latest: ProviderRawPage | undefined;
    do {
      const res = await this.kv.list({ prefix: `${RAW_PREFIX}/${provider}/`, cursor, limit: 1000 });
      for (const key of res.keys) {
        const value = await this.kv.get<ProviderRawPage>(key.name, 'json');
        if (value && (!predicate || predicate(value))) {
          if (!latest || value.fetchedAt > latest.fetchedAt) {
            latest = value;
          }
        }
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
    return latest;
  }

  async getAll(): Promise<ProviderRawPage[]> {
    let cursor: string | undefined;
    const items: ProviderRawPage[] = [];
    do {
      const res = await this.kv.list({ prefix: `${RAW_PREFIX}/`, cursor, limit: 1000 });
      for (const key of res.keys) {
        const value = await this.kv.get<ProviderRawPage>(key.name, 'json');
        if (value) items.push(value);
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
    return items;
  }
}

interface RollupState {
  rows: SpendRow[];
  lastRun?: string;
  lastError?: string | null;
  lastAlerts: Record<string, string>;
  lastCapEvaluation?: CapEvaluationResult;
}

interface UpdatePayload {
  rows: SpendRow[];
  nowIso: string;
  caps: CapConfig;
  replace?: boolean;
  lastError?: string | null;
  channels?: AlertChannels;
  hardCapWebhook?: string;
}

export interface RollupResponse {
  rows: SpendRow[];
  lastRun?: string;
  lastError?: string | null;
  evaluation?: CapEvaluationResult;
}

const defaultState: RollupState = {
  rows: [],
  lastAlerts: {},
};

export class RollupDO {
  private stateData: RollupState = { ...defaultState };
  private ready: Promise<void>;

  constructor(private readonly state: DurableObjectState) {
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RollupState>('state');
      if (stored) {
        this.stateData = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/update':
        if (request.method !== 'POST') break;
        return this.handleUpdate(request);
      case '/state':
        if (request.method !== 'GET') break;
        return Response.json(this.serialize());
      case '/spend':
        if (request.method !== 'GET') break;
        return this.handleSpend(url);
      default:
        break;
    }
    return new Response('Not found', { status: 404 });
  }

  private serialize(): RollupResponse {
    return {
      rows: this.stateData.rows,
      lastRun: this.stateData.lastRun,
      lastError: this.stateData.lastError,
      evaluation: this.stateData.lastCapEvaluation,
    };
  }

  private async handleUpdate(request: Request): Promise<Response> {
    const payload = (await request.json()) as UpdatePayload;
    const now = new Date(payload.nowIso ?? new Date().toISOString());
    const incoming = payload.rows ?? [];

    if (payload.replace) {
      this.stateData.rows = upsertRows([], incoming, now);
    } else {
      this.stateData.rows = upsertRows(this.stateData.rows, incoming, now);
    }

    this.stateData.lastRun = payload.nowIso;
    if (payload.lastError !== undefined) {
      this.stateData.lastError = payload.lastError;
    }

    const evaluation = evaluateCaps(this.stateData.rows, payload.caps, now);
    this.stateData.lastCapEvaluation = evaluation;

    if (payload.channels || payload.hardCapWebhook) {
      const result = await dispatchCapAlerts(
        { breaches: evaluation.breaches, totals: evaluation.totals },
        {
          channels: payload.channels ?? {},
          hardCapWebhook: payload.hardCapWebhook,
          lastSent: this.stateData.lastAlerts,
        },
        now,
      );
      this.stateData.lastAlerts = result.lastSent;
    }

    await this.persist();
    return Response.json(this.serialize());
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', this.stateData);
  }

  private handleSpend(url: URL): Response {
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const groupBy = (url.searchParams.get('groupBy') ?? undefined) as
      | 'model'
      | 'provider'
      | 'day'
      | undefined;

    const filtered = filterRowsByRange(this.stateData.rows, from, to);
    const aggregates = aggregateRows(filtered, groupBy);
    return Response.json({ groupBy, aggregates });
  }
}
