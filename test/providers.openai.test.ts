import { describe, expect, it } from 'vitest';
import { fetchOpenAISpend } from '../src/providers/openai';

const makeResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('OpenAI provider', () => {
  it('merges usage and cost responses', async () => {
    const usage = {
      data: [
        {
          model: 'gpt-4o',
          aggregation_timestamp: 1_700_000_000,
          n_context_tokens_total: 100,
          n_generated_tokens_total: 50,
          cost: { usd: 1.23 },
        },
      ],
    };
    const cost = {
      data: [
        {
          model: 'gpt-4o',
          time_period_start: '2023-11-14T00:00:00Z',
          total_cost: { amount: 2.5, currency: 'USD' },
        },
      ],
    };

    const calls: Response[] = [makeResponse(usage), makeResponse(cost)];
    const fetchImpl = async () => calls.shift()!;

    const result = await fetchOpenAISpend(
      { apiKey: 'sk-test', orgId: 'org', projectId: 'proj' },
      { from: '2023-11-14', to: '2023-11-15', fetchImpl },
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.cost_usd).toBeCloseTo(2.5);
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.day).toBe('2023-11-14');
    expect(result.rawPages).toHaveLength(2);
  });
});
