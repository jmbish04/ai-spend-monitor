import type { ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './env';
import { handleScheduled } from './cron';
import { createApp } from './routes';

// Export the Durable Object class so that Wrangler can discover it.
export { RollupDO } from './core/rollups';

const apiRouter = createApp();

// Export the Worker handlers.
export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
		return apiRouter.fetch(request, env, ctx);
	},
	scheduled: handleScheduled,
};

