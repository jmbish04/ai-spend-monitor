import { HTTPException } from 'hono/http-exception';
import { createMiddleware } from 'hono/factory';

const encoder = new TextEncoder();

const timingSafeEqual = (a: string, b: string): boolean => {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }

  if (typeof crypto?.subtle !== 'undefined' && 'timingSafeEqual' in crypto.subtle) {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual: (a: BufferSource, b: BufferSource) => boolean;
    };
    return subtle.timingSafeEqual(aBytes, bBytes);
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
};

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
    if (!timingSafeEqual(provided, token)) {
      throw new HTTPException(403, { message: 'Invalid bearer token' });
    }
    await next();
  });
