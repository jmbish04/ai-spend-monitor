import { describe, expect, it } from 'vitest';
import { evaluateCaps, shouldSendAlert, updateAlertTimestamps } from '../src/core/caps';
import type { CapConfig, SpendRow } from '../src/core/types';

const caps: CapConfig = {
  openaiSoft: 10,
  openaiHard: 20,
  anthropicSoft: 5,
  anthropicHard: 10,
  vertexSoft: 0,
  vertexHard: 0,
  globalSoft: 25,
  globalHard: 40,
};

describe('Cap evaluation', () => {
  it('detects soft and hard breaches', () => {
    const rows: SpendRow[] = [
      { provider: 'openai', day: '2024-01-02', cost_usd: 20, currency: 'USD', source: 'usage_api' },
      { provider: 'anthropic', day: '2024-01-02', cost_usd: 10, currency: 'USD', source: 'usage_api' },
    ];
    const now = new Date('2024-01-15T00:00:00Z');
    const result = evaluateCaps(rows, caps, now);
    expect(result.breaches.length).toBeGreaterThan(0);
    expect(result.breaches.some((b) => b.scope === 'openai' && b.level === 'soft')).toBe(true);
    expect(result.breaches.some((b) => b.scope === 'anthropic' && b.level === 'soft')).toBe(true);
    expect(result.breaches.some((b) => b.scope === 'global')).toBe(true);
  });

  it('debounces alerts by timestamp', () => {
    const breach = {
      scope: 'global' as const,
      level: 'soft' as const,
      threshold: 10,
      total: 12,
      triggeredAt: new Date().toISOString(),
    };
    const now = new Date();
    const eligible = shouldSendAlert([breach], {}, now, 3600_000);
    expect(eligible).toHaveLength(1);
    const updated = updateAlertTimestamps({}, eligible, now);
    const suppressed = shouldSendAlert([breach], updated, now, 3600_000);
    expect(suppressed).toHaveLength(0);
  });
});
