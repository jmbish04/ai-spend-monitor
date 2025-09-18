import type { FetchWithRetryArgs } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchWithRetry = async <T = unknown>({
  request,
  init,
  fetchImpl,
  maxRetries = 3,
  initialDelayMs = 500,
}: FetchWithRetryArgs): Promise<Response> => {
  const fn = fetchImpl ?? fetch;
  let attempt = 0;
  let delay = initialDelayMs;
  while (true) {
    const response = await fn(request, init);
    if (!response.status || response.status < 500 || response.status >= 600) {
      return response;
    }
    attempt += 1;
    if (attempt > maxRetries) {
      return response;
    }
    await sleep(delay);
    delay *= 2;
  }
};

export const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
};
