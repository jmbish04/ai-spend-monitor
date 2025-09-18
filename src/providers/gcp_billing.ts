import { formatUtcDate } from '../core/rollups';
import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { ProviderFetchOptions, ProviderRawPage, ProviderResult, SpendRow } from '../core/types';
import { mintAccessToken } from './google_auth';

interface BudgetsResponse {
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

interface BillingConfig {
  serviceAccountJson: string;
  budgetName: string;
}

export const fetchVertexSpendViaBudget = async (
  config: BillingConfig,
  options: ProviderFetchOptions,
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
  const rows: SpendRow[] = [
    {
      provider: 'vertex',
      day: formatUtcDate(now),
      cost_usd: toAmount(budget.currentSpend ?? budget.amountSpent ?? { units: '0' }),
      currency: 'USD',
      source: 'budgets_api',
    },
  ];
  if (budget.forecastedSpend) {
    rows.push({
      provider: 'vertex',
      day: formatUtcDate(now),
      cost_usd: toAmount(budget.forecastedSpend),
      currency: 'USD',
      source: 'budgets_api',
      model: 'forecast',
    });
  }

  return {
    rows,
    rawPages: [
      {
        id: crypto.randomUUID(),
        provider: 'vertex',
        fetchedAt: now.toISOString(),
        window: { from: options.from, to: options.to },
        payload: budget,
        meta: { endpoint: 'budgets' },
      },
    ],
  };
};

export const vertexBudgetRowsFromRaw = (pages: ProviderRawPage<any>[]): SpendRow[] => {
  return pages.map((page) => {
    const budget = page.payload as BudgetsResponse;
    const now = new Date(page.fetchedAt);
    const rows: SpendRow[] = [
      {
        provider: 'vertex',
        day: formatUtcDate(now),
        cost_usd: toAmount(budget.currentSpend ?? budget.amountSpent ?? { units: '0' }),
        currency: 'USD',
        source: 'budgets_api',
      },
    ];
    if (budget.forecastedSpend) {
      rows.push({
        provider: 'vertex',
        day: formatUtcDate(now),
        cost_usd: toAmount(budget.forecastedSpend),
        currency: 'USD',
        source: 'budgets_api',
        model: 'forecast',
      });
    }
    return rows;
  }).flat();
};
