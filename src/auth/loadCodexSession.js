// @ts-nocheck
import fs from 'node:fs/promises';

// Public OAuth client id used by the Codex CLI for ChatGPT login refreshes.
const CODEX_OAUTH_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = process.env.CODEX_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let refreshInFlight = null;

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshAuthFile(authFile) {
  const authJson = JSON.parse(await fs.readFile(authFile, 'utf8'));
  const refreshToken = normalizeString(authJson?.tokens?.refresh_token);
  if (!refreshToken) {
    const error = new Error('Codex access token is expired and auth.json has no refresh_token. Run `codex login` again.');
    error.code = 'UNAUTHORIZED';
    throw error;
  }

  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email'
    })
  });
  if (!response.ok) {
    const error = new Error(`Codex token refresh failed with HTTP ${response.status}. Run \`codex login\` again.`);
    error.code = 'UNAUTHORIZED';
    error.status = response.status;
    throw error;
  }

  const refreshed = await response.json();
  authJson.tokens = {
    ...authJson.tokens,
    ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {})
  };
  authJson.last_refresh = new Date().toISOString();

  // Write atomically and keep the owner-only mode: a torn auth.json would log the user out.
  const tmp = `${authFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(authJson, null, 2), { mode: 0o600 });
  await fs.rename(tmp, authFile);
}

/**
 * Refresh the ChatGPT access token in auth.json when it is expired or about to expire.
 * Concurrent callers share one refresh so the rotating refresh_token is used once.
 *
 * @param {string} authFile - Path to the Codex auth.json file.
 * @returns {Promise<boolean>} true when a refresh happened.
 */
export async function ensureFreshCodexAuth(authFile) {
  const authJson = JSON.parse(await fs.readFile(authFile, 'utf8'));
  if (authJson?.auth_mode !== 'chatgpt') return false;
  const expiry = jwtExpiryMs(authJson?.tokens?.access_token);
  if (expiry && expiry - Date.now() > REFRESH_MARGIN_MS) return false;

  if (!refreshInFlight) {
    refreshInFlight = refreshAuthFile(authFile).finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
  return true;
}

/**
 * Load Codex auth/session state from the local files on disk.
 *
 * @param {{ authFile: string, installationIdFile: string }} options - File paths for the Codex auth and installation ID files.
 * @returns {Promise<{ authFile: string, authMode: string | null, lastRefresh: string | null, accessToken: string | null, accountId: string | null, idToken: string | null, refreshToken: string | null, installationId: string | null, raw: unknown }>}
 */
export async function loadCodexSession({ authFile, installationIdFile }) {
  await ensureFreshCodexAuth(authFile);
  const authRaw = await fs.readFile(authFile, 'utf8');
  const authJson = JSON.parse(authRaw);
  const tokens = authJson?.tokens ?? {};

  let installationId = null;
  try {
    installationId = normalizeString(await fs.readFile(installationIdFile, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return {
    authFile,
    authMode: normalizeString(authJson?.auth_mode),
    lastRefresh: normalizeString(authJson?.last_refresh),
    accessToken: normalizeString(tokens?.access_token),
    accountId: normalizeString(tokens?.account_id),
    idToken: normalizeString(tokens?.id_token),
    refreshToken: normalizeString(tokens?.refresh_token),
    installationId,
    raw: authJson
  };
}
