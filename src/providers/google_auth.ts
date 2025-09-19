import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { OAuthTokenResponse } from '../core/types';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const BASE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const encoder = new TextEncoder();

const base64Encode = (input: Uint8Array | string): string => {
  if (typeof input === 'string') {
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(input)));
    }
    return Buffer.from(input, 'utf8').toString('base64');
  }
  if (typeof btoa === 'function') {
    let binary = '';
    input.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }
  return Buffer.from(input).toString('base64');
};

const base64UrlEncode = (input: Uint8Array | string): string =>
  base64Encode(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const pemToArrayBuffer = (pem: string): ArrayBuffer => {
  const sanitized = pem.replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = typeof atob === 'function' ? atob(sanitized) : Buffer.from(sanitized, 'base64').toString('latin1');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const createJwt = async (key: ServiceAccountKey, scopes: string[], now: Date): Promise<string> => {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + 3600;
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: key.token_uri ?? BASE_TOKEN_URI,
      iat,
      exp,
    }),
  );

  const toSign = `${header}.${payload}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(key.private_key),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(toSign));
  const signed = base64UrlEncode(new Uint8Array(signature));
  return `${toSign}.${signed}`;
};

export const mintAccessToken = async (
  serviceAccountJson: string,
  scopes: string[],
  fetchImpl?: typeof fetch,
  now: Date = new Date(),
): Promise<OAuthTokenResponse> => {
  const key = JSON.parse(serviceAccountJson) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) {
    throw new Error('Invalid service account JSON');
  }
  const assertion = await createJwt(key, scopes, now);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetchWithRetry({
    request: key.token_uri ?? BASE_TOKEN_URI,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    fetchImpl,
  });

  return parseJsonResponse<OAuthTokenResponse>(response);
};
