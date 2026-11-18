/**
 * Refresh the ChatGPT access token in auth.json when it is expired or about to expire.
 * Concurrent callers share one refresh so the rotating refresh_token is used once.
 *
 * @param {string} authFile - Path to the Codex auth.json file.
 * @returns {Promise<boolean>} true when a refresh happened.
 */
export function ensureFreshCodexAuth(authFile: string): Promise<boolean>;
/**
 * Load Codex auth/session state from the local files on disk.
 *
 * @param {{ authFile: string, installationIdFile: string }} options - File paths for the Codex auth and installation ID files.
 * @returns {Promise<{ authFile: string, authMode: string | null, lastRefresh: string | null, accessToken: string | null, accountId: string | null, idToken: string | null, refreshToken: string | null, installationId: string | null, raw: unknown }>}
 */
export function loadCodexSession({ authFile, installationIdFile }: {
    authFile: string;
    installationIdFile: string;
}): Promise<{
    authFile: string;
    authMode: string | null;
    lastRefresh: string | null;
    accessToken: string | null;
    accountId: string | null;
    idToken: string | null;
    refreshToken: string | null;
    installationId: string | null;
    raw: unknown;
}>;
