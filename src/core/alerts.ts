import { AlertChannels, AlertContext, AlertResult, CapBreach } from './types';
import { shouldSendAlert, updateAlertTimestamps } from './caps';

export interface DispatchOptions {
  channels: AlertChannels;
  hardCapWebhook?: string;
  lastSent: Record<string, string>;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
}

export interface DispatchResult {
  results: AlertResult[];
  lastSent: Record<string, string>;
}

const formatBreachLine = (breach: CapBreach): string => {
  const level = breach.level === 'soft' ? 'Soft cap' : 'Hard cap';
  return `${level} breached for ${breach.scope}: $${breach.total.toFixed(2)} (threshold $${breach.threshold.toFixed(2)})`;
};

const buildAlertMessage = (breaches: CapBreach[], now: Date): string => {
  const header = `AI spend monitor detected ${breaches.length} cap breach${breaches.length === 1 ? '' : 'es'} at ${now.toISOString()}`;
  const lines = breaches.map((breach) => `• ${formatBreachLine(breach)}`);
  return [header, ...lines].join('\n');
};

const buildAlertHtml = (breaches: CapBreach[], now: Date): string => {
  const items = breaches
    .map((breach) => `<li><strong>${breach.scope}</strong> ${breach.level.toUpperCase()} &mdash; $${breach.total.toFixed(2)} (threshold $${breach.threshold.toFixed(2)})</li>`)
    .join('');
  return `<p>AI spend monitor detected ${breaches.length} cap breach${breaches.length === 1 ? '' : 'es'} at ${now.toISOString()}.</p><ul>${items}</ul>`;
};

const postJson = async (url: string, body: unknown, fetchImpl: typeof fetch): Promise<boolean> => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.ok;
};

export const dispatchCapAlerts = async (
  context: AlertContext,
  options: DispatchOptions,
  now: Date,
): Promise<DispatchResult> => {
  const debounceMs = options.debounceMs ?? 60 * 60 * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const toNotify = shouldSendAlert(context.breaches, options.lastSent, now, debounceMs);

  if (toNotify.length === 0) {
    return { results: [], lastSent: options.lastSent };
  }

  const results: AlertResult[] = [];
  const message = buildAlertMessage(toNotify, now);
  const html = buildAlertHtml(toNotify, now);

  if (options.channels.slackWebhook) {
    try {
      const ok = await postJson(
        options.channels.slackWebhook,
        {
          text: message,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*AI spend monitor alert*\n${message}` } },
            {
              type: 'context',
              elements: toNotify.map((breach) => ({
                type: 'mrkdwn',
                text: formatBreachLine(breach),
              })),
            },
          ],
        },
        fetchImpl,
      );
      results.push({ channel: 'slack', ok });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          channel: 'slack',
          message: (err as Error).message,
        }),
      );
      results.push({ channel: 'slack', ok: false });
    }
  }

  if (options.channels.emailWebhook) {
    try {
      const ok = await postJson(
        options.channels.emailWebhook,
        {
          subject: '[AI Spend Monitor] Cap breach detected',
          text: message,
          html,
        },
        fetchImpl,
      );
      results.push({ channel: 'email', ok });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          channel: 'email',
          message: (err as Error).message,
        }),
      );
      results.push({ channel: 'email', ok: false });
    }
  }

  const hardBreaches = toNotify.filter((breach) => breach.level === 'hard');
  if (hardBreaches.length > 0 && options.hardCapWebhook) {
    try {
      await postJson(
        options.hardCapWebhook,
        {
          event: 'ai_spend_hard_cap',
          breaches: hardBreaches,
          totals: context.totals,
          triggeredAt: now.toISOString(),
        },
        fetchImpl,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          channel: 'hard_cap',
          message: (err as Error).message,
        }),
      );
    }
  }

  const updated = updateAlertTimestamps(options.lastSent, toNotify, now);
  return { results, lastSent: updated };
};
