import type { ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './env';
import { handleScheduled } from './cron';
import { createApp } from './routes';

// Export the Durable Object class directly, making it discoverable by Wrangler.
export { RollupDO } from './core/storage';

const apiRouter = createApp();

// Export the Worker handlers.
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    return apiRouter.fetch(request, env, ctx);
  },
  scheduled: handleScheduled,
};
