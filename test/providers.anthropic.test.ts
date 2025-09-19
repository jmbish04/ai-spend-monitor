import { describe, expect, it } from 'vitest';
import { fetchAnthropicSpend } from '../src/providers/anthropic';

const makeResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('Anthropic provider', () => {
  it('returns spend rows with tokens', async () => {
    const page = {
      data: [
        { date: '2024-01-01', model: 'claude-3', input_tokens: 10, output_tokens: 5, cost_usd: 0.42 },
      ],
    };
    const fetchImpl = async () => makeResponse(page);

    const result = await fetchAnthropicSpend(
      { apiKey: 'anthropic-key', orgId: 'org' },
      { from: '2024-01-01', to: '2024-01-02', fetchImpl },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].model).toBe('claude-3');
    expect(result.rows[0].cost_usd).toBeCloseTo(0.42);
    expect(result.rawPages).toHaveLength(1);
  });
});
