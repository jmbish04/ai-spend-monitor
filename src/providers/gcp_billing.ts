import { formatUtcDate } from '../core/rollups';
import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { ProviderFetchOptions, ProviderRawPage, ProviderResult, SpendRow } from '../core/types';
import { mintAccessToken } from './google_auth';

export interface BudgetsResponse {
  name: string;
  amountSpend?: { units?: string; nanos?: number };
  amountSpent?: { units?: string; nanos?: number };
  amountCommitted?: { units?: string; nanos?: number };
  amount: { specifiedAmount?: { units?: string; nanos?: number } };
  budgetFilter?: Record<string, unknown>;
  allUpdatesRule?: Record<string, unknown>;
  thresholdRules?: Record<string, unknown>[];
  currentSpend?: { units?: string; nanos?: number };
  forecastedSpend?: { units?: string; nanos?: number };
}

const BUDGET_SCOPE = 'https://www.googleapis.com/auth/cloud-billing.read';

const toAmount = (value?: { units?: string; nanos?: number }): number => {
  if (!value) return 0;
  const units = Number(value.units ?? 0);
  const nanos = Number(value.nanos ?? 0);
  return units + nanos / 1_000_000_000;
};

const currentSpendFromBudget = (budget: BudgetsResponse): number =>
  toAmount(budget.currentSpend ?? budget.amountSpent ?? { units: '0' });

const buildBudgetRows = (
  budget: BudgetsResponse,
  fetchedAt: Date,
  previous?: BudgetsResponse,
): SpendRow[] => {
  const previousSpend = previous ? currentSpendFromBudget(previous) : 0;
  const currentSpend = currentSpendFromBudget(budget);
  const rawDelta = previous ? currentSpend - previousSpend : currentSpend;
  const delta = rawDelta > 0 ? rawDelta : previous ? 0 : currentSpend;

  if (delta <= 0) {
    return [];
  }

  return [
    {
      provider: 'vertex',
      day: formatUtcDate(fetchedAt),
      cost_usd: delta,
      currency: 'USD',
      source: 'budgets_api',
    },
  ];
};

interface BillingConfig {
  serviceAccountJson: string;
  budgetName: string;
}

export const fetchVertexSpendViaBudget = async (
  config: BillingConfig,
  options: ProviderFetchOptions,
  previousBudget?: BudgetsResponse,
): Promise<ProviderResult<BudgetsResponse>> => {
  const token = await mintAccessToken(config.serviceAccountJson, [BUDGET_SCOPE], options.fetchImpl);
  const response = await fetchWithRetry({
    request: `https://billingbudgets.googleapis.com/v1/${config.budgetName}`,
    init: {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
    },
    fetchImpl: options.fetchImpl,
  });
  const budget = await parseJsonResponse<BudgetsResponse>(response);
  const now = new Date();
  const rows = buildBudgetRows(budget, now, previousBudget);

  return {
    rows,
    rawPages: [
      {
        id: crypto.randomUUID(),
        provider: 'vertex',
        fetchedAt: now.toISOString(),
        window: { from: options.from, to: options.to },
        payload: budget,
        meta: {
          endpoint: 'budgets',
          currentSpend: currentSpendFromBudget(budget),
          forecastedSpend: budget.forecastedSpend ? toAmount(budget.forecastedSpend) : undefined,
        },
      },
    ],
  };
};

export const vertexBudgetRowsFromRaw = (pages: ProviderRawPage<any>[]): SpendRow[] => {
  const sorted = [...pages].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const rows: SpendRow[] = [];
  let previous: BudgetsResponse | undefined;

  for (const page of sorted) {
    const budget = page.payload as BudgetsResponse;
    const fetchedAt = new Date(page.fetchedAt);
    rows.push(...buildBudgetRows(budget, fetchedAt, previous));
    previous = budget;
  }

  return rows;
};
