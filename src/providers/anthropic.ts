import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { ProviderFetchOptions, ProviderRawPage, ProviderResult, SpendRow } from '../core/types';

interface AnthropicConfig {
  apiKey: string;
  orgId?: string;
}

interface AnthropicUsageDatum {
  date: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

interface AnthropicResponse {
  data: AnthropicUsageDatum[];
  next_page_token?: string;
}

const API_BASE = 'https://api.anthropic.com/v1/usage';

const makeHeaders = (config: AnthropicConfig): HeadersInit => {
  const headers: Record<string, string> = {
    'x-api-key': config.apiKey,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.orgId) {
    headers['anthropic-org-id'] = config.orgId;
  }
  return headers;
};

const normalize = (data: AnthropicUsageDatum[]): SpendRow[] => {
  return data.map((datum) => ({
    provider: 'anthropic',
    model: datum.model,
    day: datum.date.slice(0, 10),
    input_tokens: datum.input_tokens,
    output_tokens: datum.output_tokens,
    cost_usd: datum.cost_usd ?? 0,
    currency: 'USD',
    source: 'usage_api',
  }));
};

export const fetchAnthropicSpend = async (
  config: AnthropicConfig,
  options: ProviderFetchOptions,
): Promise<ProviderResult> => {
  const headers = makeHeaders(config);
  const url = new URL(API_BASE);
  url.searchParams.set('start_date', options.from);
  url.searchParams.set('end_date', options.to);

  const pages: AnthropicResponse[] = [];
  const raw: ProviderRawPage<AnthropicResponse>[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) {
      url.searchParams.set('page_token', pageToken);
    }
    const response = await fetchWithRetry({ request: url.toString(), init: { headers }, fetchImpl: options.fetchImpl });
    const json = await parseJsonResponse<AnthropicResponse>(response);
    pages.push(json);
    raw.push({
      id: crypto.randomUUID(),
      provider: 'anthropic',
      fetchedAt: new Date().toISOString(),
      window: { from: options.from, to: options.to },
      payload: json,
      meta: { endpoint: 'usage' },
    });
    pageToken = json.next_page_token;
  } while (pageToken);

  const rows = normalize(pages.flatMap((page) => page.data ?? []));
  return { rows, rawPages: raw };
};

export const anthropicRowsFromRaw = (pages: ProviderRawPage[]): SpendRow[] => {
  return normalize(
    pages
      .filter((page) => page.meta?.endpoint === 'usage' || !page.meta)
      .flatMap((page) => (page.payload as AnthropicResponse).data ?? []),
  );
};
