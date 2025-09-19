export type ProviderName = 'openai' | 'anthropic' | 'vertex';

export type SpendSource = 'usage_api' | 'cost_api' | 'bq_export' | 'budgets_api';

export interface SpendRow {
  provider: ProviderName;
  model?: string;
  day: string; // YYYY-MM-DD in UTC
  input_tokens?: number;
  output_tokens?: number;
  cost_usd: number;
  currency: 'USD';
  source: SpendSource;
}

export interface ProviderFetchOptions {
  from: string; // inclusive YYYY-MM-DD
  to: string; // inclusive YYYY-MM-DD
  fetchImpl?: typeof fetch;
}

export interface ProviderRawPage<T = unknown> {
  id: string;
  provider: ProviderName;
  fetchedAt: string; // ISO timestamp
  window: { from: string; to: string };
  payload: T;
  meta?: Record<string, unknown>;
}

export interface ProviderResult<T = unknown> {
  rows: SpendRow[];
  rawPages: ProviderRawPage<T>[];
}

export type GroupByOption = 'model' | 'provider' | 'day';

export interface CapConfig {
  openaiSoft: number;
  openaiHard: number;
  anthropicSoft: number;
  anthropicHard: number;
  vertexSoft: number;
  vertexHard: number;
  globalSoft: number;
  globalHard: number;
}

export type CapScope = ProviderName | 'global';

export interface CapThreshold {
  scope: CapScope;
  soft: number;
  hard: number;
}

export interface CapBreach {
  scope: CapScope;
  level: 'soft' | 'hard';
  threshold: number;
  total: number;
  triggeredAt: string;
}

export interface CapEvaluationResult {
  totals: Record<CapScope, number>;
  breaches: CapBreach[];
}

export interface RollupSummary {
  rows: SpendRow[];
  lastRun?: string;
  lastError?: string | null;
  totalsByProvider: Record<ProviderName, number>;
  globalTotal: number;
  capBreaches: CapBreach[];
}

export interface AlertContext {
  breaches: CapBreach[];
  totals: Record<CapScope, number>;
}

export interface AlertChannels {
  slackWebhook?: string;
  emailWebhook?: string;
}

export interface AlertResult {
  channel: 'slack' | 'email';
  ok: boolean;
}

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface BudgetCost {
  currentCost: number;
  forecastedCost?: number;
}

export interface FetchRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
}

export interface FetchWithRetryArgs extends FetchRetryOptions {
  request: RequestInfo;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
}
