import type { QuotaProviderId } from '@/types';
import type { I18nKey } from '@/lib/i18n';

export interface ModelFamily {
  id: string;
  label: string;
  labelKey?: I18nKey;
  matcher: (modelName: string) => boolean;
  order: number;
}

const OPENCODE_MODEL_FAMILIES: ModelFamily[] = [
  {
    id: 'opencode-models',
    label: 'Zen',
    labelKey: 'quota.family.zen',
    matcher: () => true,
    order: 1,
  },
];

const PROVIDER_MODEL_FAMILIES: Partial<Record<QuotaProviderId, ModelFamily[]>> = {
  opencode: OPENCODE_MODEL_FAMILIES,
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

const GEMINI_3_MODEL = /^gemini-3[.-]/;

export function getDefaultModels(
  providerId: QuotaProviderId,
  availableModels: string[]
): string[] {
  return availableModels.filter((model) => {
    if (providerId === 'claude') return true;
    if (providerId === 'opencode') return true;
    const lower = model.toLowerCase();
    const modelName = lower.includes('/') ? lower.split('/')[1] : lower;
    if (GEMINI_3_MODEL.test(modelName)) return true;
    if (modelName.startsWith('claude-')) return true;
    return false;
  });
}
