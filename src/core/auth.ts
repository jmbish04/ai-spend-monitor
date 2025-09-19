import { HTTPException } from 'hono/http-exception';
import { createMiddleware } from 'hono/factory';

export const requireAdmin = (token?: string) =>
  createMiddleware(async (c, next) => {
    if (!token) {
      throw new HTTPException(500, { message: 'ADMIN_TOKEN not configured' });
    }
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Missing bearer token' });
    }
    const provided = auth.substring('Bearer '.length);
    if (provided !== token) {
      throw new HTTPException(403, { message: 'Invalid bearer token' });
    }
    await next();
  });
