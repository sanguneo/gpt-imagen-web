/**
 * Resolve the runtime configuration for the CLI/library.
 *
 * @param {{ codexHome?: string, baseUrl?: string, authFile?: string, installationIdFile?: string, generatedImagesDir?: string, provider?: string, defaultModel?: string, originator?: string, defaultOutputPath?: string }} [overrides={}] - Optional configuration overrides.
 * @returns {{ baseUrl: string, codexHome: string, authFile: string, installationIdFile: string, generatedImagesDir: string, provider: string, defaultModel: string, defaultOriginator: string, defaultOutputPath: string }} Fully resolved config.
 */
export function resolveConfig(overrides?: {
    codexHome?: string;
    baseUrl?: string;
    authFile?: string;
    installationIdFile?: string;
    generatedImagesDir?: string;
    provider?: string;
    defaultModel?: string;
    originator?: string;
    defaultOutputPath?: string;
}): {
    baseUrl: string;
    codexHome: string;
    authFile: string;
    installationIdFile: string;
    generatedImagesDir: string;
    provider: string;
    defaultModel: string;
    defaultOriginator: string;
    defaultOutputPath: string;
};
export const DEFAULT_CODEX_MODEL: "gpt-6.1-sol";
export const CODEX_MODEL_CHOICES: readonly string[];
export const DEFAULT_IMAGE_MODEL: "gpt-image-2.6-flare";
export const IMAGE_MODEL_CHOICES: readonly string[];
export const UNSUPPORTED_WARNING: "WARNING: This project calls an unsupported private Codex backend path. The contract may break without notice.";
