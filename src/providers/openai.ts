import { formatUtcDate } from '../core/rollups';
import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { ProviderFetchOptions, ProviderRawPage, ProviderResult, SpendRow } from '../core/types';

interface OpenAIConfig {
  apiKey: string;
  orgId?: string;
  projectId?: string;
}

interface UsageDatum {
  aggregation_timestamp?: number;
  model?: string;
  n_context_tokens_total?: number;
  n_generated_tokens_total?: number;
  cost?: { usd?: number };
  usage?: { total_usage?: number };
  snapshot_id?: string;
  time_bucket?: string;
}

interface UsageResponse {
  data: UsageDatum[];
  has_more?: boolean;
  next_page?: string;
}

interface CostDatum {
  model?: string;
  time_period_start?: string;
  time_period_end?: string;
  total_cost?: { amount?: number; currency?: string };
}

interface CostResponse {
  data: CostDatum[];
  has_more?: boolean;
  next_page?: string;
}

const API_BASE = 'https://api.openai.com/v1';

const makeHeaders = (config: OpenAIConfig): HeadersInit => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  };
  if (config.orgId) {
    headers['OpenAI-Organization'] = config.orgId;
  }
  return headers;
};

const toDay = (datum: UsageDatum | CostDatum): string | undefined => {
  if ('aggregation_timestamp' in datum && datum.aggregation_timestamp) {
    return formatUtcDate(new Date(datum.aggregation_timestamp * 1000));
  }
  if ('time_bucket' in datum && datum.time_bucket) {
    return datum.time_bucket.slice(0, 10);
  }
  if ('time_period_start' in datum && datum.time_period_start) {
    return datum.time_period_start.slice(0, 10);
  }
  return undefined;
};

const usageKey = (model: string | undefined, day: string | undefined): string =>
  `${model ?? 'unknown'}|${day ?? 'unknown'}`;

const fetchPaginated = async <T extends UsageResponse | CostResponse>(
  url: URL,
  headers: HeadersInit,
  endpoint: 'usage' | 'costs',
  fetchImpl?: typeof fetch,
): Promise<{ pages: T[]; raw: ProviderRawPage<T>[] }> => {
  const pages: T[] = [];
  const raw: ProviderRawPage<T>[] = [];
  let next: string | undefined;
  do {
    if (next) {
      url.searchParams.set('page', next);
    }
    const response = await fetchWithRetry({ request: url.toString(), init: { headers }, fetchImpl });
    const json = await parseJsonResponse<T>(response);
    pages.push(json);
    raw.push({
      id: crypto.randomUUID(),
      provider: 'openai',
      fetchedAt: new Date().toISOString(),
      window: { from: url.searchParams.get('start_date') ?? '', to: url.searchParams.get('end_date') ?? '' },
      payload: json,
      meta: { endpoint },
    });
    next = (json as UsageResponse | CostResponse).next_page ?? undefined;
  } while (next);
  return { pages, raw };
};

const normalizeUsage = (pages: UsageResponse[]): Map<string, SpendRow> => {
  const map = new Map<string, SpendRow>();
  for (const page of pages) {
    for (const datum of page.data ?? []) {
      const day = toDay(datum);
      const model = datum.model ?? 'unknown';
      const key = usageKey(model, day);
      const row = map.get(key) ?? {
        provider: 'openai',
        model,
        day: day ?? 'unknown',
        cost_usd: 0,
        currency: 'USD',
        source: 'usage_api',
      };
      if (datum.n_context_tokens_total) {
        row.input_tokens = (row.input_tokens ?? 0) + datum.n_context_tokens_total;
      }
      if (datum.n_generated_tokens_total) {
        row.output_tokens = (row.output_tokens ?? 0) + datum.n_generated_tokens_total;
      }
      if (datum.cost?.usd) {
        row.cost_usd += datum.cost.usd;
      }
      map.set(key, row);
    }
  }
  return map;
};

const mergeCosts = (map: Map<string, SpendRow>, costPages: CostResponse[]): void => {
  for (const page of costPages) {
    for (const datum of page.data ?? []) {
      const day = toDay(datum);
      const model = datum.model ?? 'unknown';
      const key = usageKey(model, day);
      const existing = map.get(key);
      const costUsd = datum.total_cost?.amount ?? 0;
      if (existing) {
        existing.cost_usd = costUsd;
        existing.source = existing.source === 'usage_api' ? 'cost_api' : existing.source;
      } else if (day) {
        map.set(key, {
          provider: 'openai',
          model,
          day,
          cost_usd: costUsd,
          currency: 'USD',
          source: 'cost_api',
        });
      }
    }
  }
};

export const fetchOpenAISpend = async (
  config: OpenAIConfig,
  options: ProviderFetchOptions,
): Promise<ProviderResult> => {
  const usageUrl = new URL(`${API_BASE}/usage`);
  usageUrl.searchParams.set('start_date', options.from);
  usageUrl.searchParams.set('end_date', options.to);
  if (config.projectId) {
    usageUrl.searchParams.set('project_id', config.projectId);
  }

  const headers = makeHeaders(config);
  const { pages: usagePages, raw: usageRaw } = await fetchPaginated<UsageResponse>(usageUrl, headers, 'usage', options.fetchImpl);

  const costUrl = new URL(`${API_BASE}/costs`);
  costUrl.searchParams.set('start_date', options.from);
  costUrl.searchParams.set('end_date', options.to);
  if (config.projectId) {
    costUrl.searchParams.set('project_id', config.projectId);
  }

  const { pages: costPages, raw: costRaw } = await fetchPaginated<CostResponse>(costUrl, headers, 'costs', options.fetchImpl);

  const map = normalizeUsage(usagePages);
  mergeCosts(map, costPages);

  const rows = Array.from(map.values()).map<SpendRow>((row) => ({
    ...row,
    day: row.day,
    source: row.source ?? 'usage_api',
    cost_usd: Number(row.cost_usd.toFixed(6)),
  }));

  return {
    rows,
    rawPages: [...usageRaw, ...costRaw],
  };
};

export const openAiRowsFromRaw = (pages: ProviderRawPage[]): SpendRow[] => {
  const usagePages = pages
    .filter((page) => page.meta?.endpoint === 'usage')
    .map((page) => page.payload as UsageResponse);
  const costPages = pages
    .filter((page) => page.meta?.endpoint === 'costs')
    .map((page) => page.payload as CostResponse);
  const map = normalizeUsage(usagePages);
  mergeCosts(map, costPages);
  return Array.from(map.values()).map((row) => ({
    ...row,
    cost_usd: Number(row.cost_usd.toFixed(6)),
  }));
};
