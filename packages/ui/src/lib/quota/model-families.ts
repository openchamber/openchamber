import type { QuotaProviderId } from '@/types';

export interface ModelFamily {
  id: string;
  label: string;
  matcher: (modelName: string) => boolean;
  order: number;
}

/**
 * Strip auth source prefix from model name for display.
 * e.g., "gemini/gemini-2.5-flash" -> "gemini-2.5-flash"
 *       "antigravity/claude-sonnet" -> "claude-sonnet"
 */
export function getDisplayModelName(modelName: string): string {
  // Handle prefixes like "gemini/", "antigravity/"
  const slashIndex = modelName.indexOf('/');
  if (slashIndex !== -1) {
    const prefix = modelName.substring(0, slashIndex);
    // Check if it's an auth source prefix
    if (prefix === 'gemini' || prefix === 'antigravity') {
      return modelName.substring(slashIndex + 1);
    }
  }
  return modelName;
}

const GOOGLE_MODEL_FAMILIES: ModelFamily[] = [
  {
    id: 'gemini-auth',
    label: 'Gemini',
    matcher: (modelName) => modelName.startsWith('gemini/'),
    order: 1,
  },
  {
    id: 'antigravity-auth',
    label: 'Antigravity',
    matcher: (modelName) => modelName.startsWith('antigravity/'),
    order: 2,
  },
];

const PROVIDER_MODEL_FAMILIES: Record<string, ModelFamily[]> = {
  google: GOOGLE_MODEL_FAMILIES,
};

function getModelFamily(modelName: string, providerId: QuotaProviderId): ModelFamily | null {
  const families = PROVIDER_MODEL_FAMILIES[providerId] ?? [];
  for (const family of families) {
    if (family.matcher(modelName)) {
      return family;
    }
  }
  return null;
}

export function getAllModelFamilies(providerId: QuotaProviderId): ModelFamily[] {
  return PROVIDER_MODEL_FAMILIES[providerId] ?? [];
}

export function sortModelFamilies(families: ModelFamily[]): ModelFamily[] {
  return [...families].sort((a, b) => a.order - b.order);
}

/**
 * Group model names by family (for backward compatibility with Header.tsx)
 */
export function groupModelsByFamily(
  models: Record<string, unknown>,
  providerId: QuotaProviderId
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();

  for (const modelName of Object.keys(models)) {
    const family = getModelFamily(modelName, providerId);
    const familyId = family?.id ?? null;

    if (!groups.has(familyId)) {
      groups.set(familyId, []);
    }
    groups.get(familyId)!.push(modelName);
  }

  return groups;
}

/**
 * Group models by family with custom getter function (for UsagePage.tsx)
 */
export function groupModelsByFamilyWithGetter<T>(
  models: T[],
  getModelName: (model: T) => string,
  providerId: QuotaProviderId
): Map<string | null, T[]> {
  const groups = new Map<string | null, T[]>();

  for (const model of models) {
    const modelName = getModelName(model);
    const family = getModelFamily(modelName, providerId);
    const familyId = family?.id ?? null;

    if (!groups.has(familyId)) {
      groups.set(familyId, []);
    }
    groups.get(familyId)!.push(model);
  }

  return groups;
}

/**
 * Match Gemini 3.x on the version token rather than on the separator that
 * follows it. Google writes the minor version with a dot
 * (`gemini-3.6-flash`), a few gateway providers write it with a hyphen
 * (`gemini-3-6-flash`), and the launch ids carry no minor version at all
 * (`gemini-3-flash`). Requiring a separator after `gemini-3` covers all
 * three, and the leading anchor keeps the earlier generations, the versionless
 * aliases, and the embedding models out.
 */
const GEMINI_3_MODEL = /^gemini-3[.-]/;

/**
 * Get default models for a provider based on simple patterns.
 * For Google provider with gemini/ and antigravity/ prefixes:
 * - Gemini 3.x models
 * - All Claude models
 * For the Claude provider: every model it reports a limit for.
 */
export function getDefaultModels(
  providerId: QuotaProviderId,
  availableModels: string[]
): string[] {
  return availableModels.filter((model) => {
    // Anthropic only reports a model here when that model has its own plan
    // limit, so every one it names is worth showing by default.
    if (providerId === 'claude') return true;
    const lower = model.toLowerCase();
    // Handle gemini/ and antigravity/ prefixes
    const modelName = lower.includes('/') ? lower.split('/')[1] : lower;
    // Gemini 3.x, including the dotted (gemini-3.6-flash) and hyphenated
    // (gemini-3-6-flash) minor versions
    if (GEMINI_3_MODEL.test(modelName)) return true;
    // All Claude models
    if (modelName.startsWith('claude-')) return true;
    return false;
  });
}
