import { describe, expect, it, vi } from 'vitest';
import { fetchVertexSpendViaBudget } from '../src/providers/gcp_billing';

vi.mock('../src/providers/google_auth', () => ({
  mintAccessToken: vi.fn(async () => ({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' })),
}));

const makeResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('GCP budgets provider', () => {
  it('maps current and forecasted spend', async () => {
    const fetchImpl = async () =>
      makeResponse({
        currentSpend: { units: '5', nanos: 0 },
        forecastedSpend: { units: '7', nanos: 500_000_000 },
      });

    const result = await fetchVertexSpendViaBudget(
      { serviceAccountJson: '{}', budgetName: 'projects/x/billingAccounts/y/budgets/z' },
      { from: '2024-01-01', to: '2024-01-02', fetchImpl },
    );

    expect(result.rows).toHaveLength(2);
    const [current, forecast] = result.rows;
    expect(current.cost_usd).toBeCloseTo(5);
    expect(forecast.model).toBe('forecast');
    expect(result.rawPages).toHaveLength(1);
  });
});
