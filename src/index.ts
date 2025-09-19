import type { ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './env';
import { handleScheduled } from './cron';
import { createApp } from './routes';
// Import the Durable Object class directly.
import { RollupDO as RollupDOClass } from './core/storage';

// Export the Durable Object class as a named constant.
// This makes it explicitly discoverable by Wrangler during deployment.
export const RollupDO = RollupDOClass;

const apiRouter = createApp();

// Export the Worker handlers.
export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
		return apiRouter.fetch(request, env, ctx);
	},
	scheduled: handleScheduled,
};

