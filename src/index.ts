import type { ExecutionContext } from '@cloudflare/workers-types';
import { createApp } from './routes/index';
import { handleScheduled } from './cron';
import { RollupDO } from './core/storage';

const app = createApp();

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: handleScheduled,
  RollupDO,
};
