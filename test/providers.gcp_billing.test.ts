import { describe, expect, it, vi } from 'vitest';
import { fetchVertexSpendViaBudget, vertexBudgetRowsFromRaw } from '../src/providers/gcp_billing';
import type { ProviderRawPage } from '../src/core/types';
import type { BudgetsResponse } from '../src/providers/gcp_billing';

vi.mock('../src/providers/google_auth', () => ({
  mintAccessToken: vi.fn(async () => ({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' })),
}));

const makeResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('GCP budgets provider', () => {
  const baseBudget: BudgetsResponse = {
    name: 'budgets/123',
    amount: {},
  };

  it('computes delta spend when previous total is provided', async () => {
    const fetchImpl = async () =>
      makeResponse({
        ...baseBudget,
        currentSpend: { units: '10', nanos: 0 },
      });

    const previous: BudgetsResponse = {
      ...baseBudget,
      currentSpend: { units: '6', nanos: 0 },
    };

    const result = await fetchVertexSpendViaBudget(
      { serviceAccountJson: '{}', budgetName: 'projects/x/billingAccounts/y/budgets/z' },
      { from: '2024-01-01', to: '2024-01-02', fetchImpl },
      previous,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cost_usd).toBeCloseTo(4);
    expect(result.rawPages).toHaveLength(1);
  });

  it('derives incremental rows from raw pages', () => {
    const pages: ProviderRawPage[] = [
      {
        id: 'a',
        provider: 'vertex',
        fetchedAt: '2024-01-01T00:00:00.000Z',
        window: { from: '2024-01-01', to: '2024-01-02' },
        payload: { ...baseBudget, currentSpend: { units: '5', nanos: 0 } },
      },
      {
        id: 'b',
        provider: 'vertex',
        fetchedAt: '2024-01-02T00:00:00.000Z',
        window: { from: '2024-01-02', to: '2024-01-03' },
        payload: { ...baseBudget, currentSpend: { units: '7', nanos: 0 } },
      },
    ];

    const rows = vertexBudgetRowsFromRaw(pages);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cost_usd).toBeCloseTo(5);
    expect(rows[1]?.cost_usd).toBeCloseTo(2);
  });
});
