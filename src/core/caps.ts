import { CapBreach, CapConfig, CapEvaluationResult, CapScope, SpendRow } from './types';
import { monthToDateRows } from './rollups';

const providerScopes: CapScope[] = ['openai', 'anthropic', 'vertex'];

const capKey = (scope: CapScope, level: 'soft' | 'hard'): string => `${scope}:${level}`;

export const evaluateCaps = (rows: SpendRow[], caps: CapConfig, now: Date): CapEvaluationResult => {
  const monthRows = monthToDateRows(rows, now);
  const totals: Record<CapScope, number> = {
    openai: 0,
    anthropic: 0,
    vertex: 0,
    global: 0,
  };

  for (const row of monthRows) {
    totals[row.provider] += row.cost_usd;
    totals.global += row.cost_usd;
  }

  const breaches: CapBreach[] = [];
  const pushBreach = (scope: CapScope, level: 'soft' | 'hard', threshold: number): void => {
    if (!threshold) return;
    const total = totals[scope];
    if (total >= threshold) {
      breaches.push({
        scope,
        level,
        threshold,
        total,
        triggeredAt: now.toISOString(),
      });
    }
  };

  const scopeCaps: Record<CapScope, { soft: number; hard: number }> = {
    openai: { soft: caps.openaiSoft, hard: caps.openaiHard },
    anthropic: { soft: caps.anthropicSoft, hard: caps.anthropicHard },
    vertex: { soft: caps.vertexSoft, hard: caps.vertexHard },
    global: { soft: caps.globalSoft, hard: caps.globalHard },
  };

  for (const scope of providerScopes) {
    pushBreach(scope, 'soft', scopeCaps[scope].soft);
    pushBreach(scope, 'hard', scopeCaps[scope].hard);
  }
  pushBreach('global', 'soft', scopeCaps.global.soft);
  pushBreach('global', 'hard', scopeCaps.global.hard);

  return { totals, breaches };
};

export const shouldSendAlert = (
  breaches: CapBreach[],
  lastSent: Record<string, string>,
  now: Date,
  debounceMs: number,
): CapBreach[] => {
  const eligible: CapBreach[] = [];
  for (const breach of breaches) {
    const key = capKey(breach.scope, breach.level);
    const last = lastSent[key];
    if (!last) {
      eligible.push(breach);
      continue;
    }
    const lastDate = new Date(last);
    if (now.getTime() - lastDate.getTime() >= debounceMs) {
      eligible.push(breach);
    }
  }
  return eligible;
};

export const updateAlertTimestamps = (
  lastSent: Record<string, string>,
  breaches: CapBreach[],
  now: Date,
): Record<string, string> => {
  const updated = { ...lastSent };
  for (const breach of breaches) {
    updated[capKey(breach.scope, breach.level)] = now.toISOString();
  }
  return updated;
};
