import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

function basicAuthHeader() {
  if (!config.zoom.clientId || !config.zoom.clientSecret) {
    throw new Error('ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are required');
  }
  const value = Buffer.from(`${config.zoom.clientId}:${config.zoom.clientSecret}`).toString('base64');
  return `Basic ${value}`;
}

export function zoomRedirectUri() {
  if (config.zoom.oauthRedirectUri) return config.zoom.oauthRedirectUri;
  if (!config.publicBaseUrl) {
    throw new Error('ZOOM_OAUTH_REDIRECT_URI or PUBLIC_BASE_URL is required');
  }
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/zoom/oauth/callback`;
}

export function zoomAuthorizationUrl({ state = '' } = {}) {
  if (!config.zoom.clientId) {
    throw new Error('ZOOM_CLIENT_ID is required');
  }

  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.zoom.clientId);
  url.searchParams.set('redirect_uri', zoomRedirectUri());
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function writeZoomToken(token) {
  await fs.mkdir(path.dirname(config.zoom.oauthTokenPath), { recursive: true });
  await fs.writeFile(config.zoom.oauthTokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  return token;
}

export async function readZoomToken() {
  try {
    const text = await fs.readFile(config.zoom.oauthTokenPath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requestZoomToken(params) {
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zoom OAuth token request failed: ${response.status} ${text}`);
  }

  const token = JSON.parse(text);
  const now = Date.now();
  return {
    ...token,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Number(token.expires_in ?? 0) * 1000).toISOString()
  };
}

export async function exchangeZoomAuthorizationCode(code) {
  if (!code) throw new Error('Missing Zoom OAuth code');
  const token = await requestZoomToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: zoomRedirectUri()
  });
  return writeZoomToken(token);
}

export async function refreshZoomToken() {
  const current = await readZoomToken();
  if (!current?.refresh_token) {
    throw new Error('No Zoom refresh token is stored yet');
  }

  const token = await requestZoomToken({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token
  });
  return writeZoomToken(token);
}

export async function getZoomAccessToken() {
  const token = await readZoomToken();
  if (!token?.access_token) {
    throw new Error('Zoom account is not connected. Open /zoom/oauth/start first.');
  }

  const expiresAt = Date.parse(token.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() < 120_000) {
    return (await refreshZoomToken()).access_token;
  }

  return token.access_token;
}

export async function zoomOAuthStatus() {
  const token = await readZoomToken();
  let redirectUri = '';
  let configError = '';
  try {
    redirectUri = zoomRedirectUri();
  } catch (error) {
    configError = error.message;
  }

  if (!token) {
    return {
      connected: false,
      redirectUri,
      tokenPath: config.zoom.oauthTokenPath,
      configError
    };
  }

  const fingerprint = crypto
    .createHash('sha256')
    .update(token.access_token ?? '')
    .digest('hex')
    .slice(0, 12);

  return {
    connected: Boolean(token.access_token),
    expiresAt: token.expiresAt ?? '',
    scope: token.scope ?? '',
    apiUrl: token.api_url ?? 'https://api.zoom.us',
    redirectUri,
    tokenPath: config.zoom.oauthTokenPath,
    tokenFingerprint: fingerprint,
    configError
  };
}
