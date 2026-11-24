import { mayBeReloading } from '../openchamber-sessions/catalog-reload.js';
import type { ModelInfo, OpenCodeClient } from '@opencode/client';
import { isAutoModel } from '../routing/defaults.js';
import { readChatsDefaults } from './chats-scope.js';

export interface SessionDefaultSettings {
  defaultModel?: unknown;
  defaultVariant?: unknown;
  defaultAgent?: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';

const splitModel = (value: SessionDefaultSettings['defaultModel']) => {
  const text = isString(value) ? value.trim() : '';
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
};

const text = (value: SessionDefaultSettings['defaultAgent']) => (isString(value) && value.trim() ? value.trim() : null);

const findCatalogModel = (catalog: readonly ModelInfo[], model: { providerID: string; modelID: string }) => {
  const ofProvider = catalog.filter((entry) => entry.providerID === model.providerID);
  return ofProvider.find((entry) => entry.id === model.modelID) ?? ofProvider.find((entry) => entry.modelID === model.modelID) ?? null;
};

const sameModel = (a: ReturnType<typeof splitModel>, b: ReturnType<typeof splitModel>) => !!a && !!b
  && a.providerID === b.providerID && a.modelID === b.modelID;

export const readModelCatalog = (client: Pick<OpenCodeClient, 'model'>) => client.model
  .list(undefined, { signal: AbortSignal.timeout(10_000) })
  .then((response) => (Array.isArray(response?.data) ? response.data : null))
  .catch(() => null);

export const resolveSessionDefaults = ({ settings, project, catalog = null }: {
  settings?: SessionDefaultSettings | null;
  project?: SessionDefaultSettings | null;
  catalog?: readonly ModelInfo[] | null;
}) => {
  const known = catalog && catalog.length > 0 ? catalog : null;
  const runnable = (model: ReturnType<typeof splitModel>) => {
    if (!model || !known || isAutoModel(model) || mayBeReloading(known, model.providerID)) return !!model;
    const entry = findCatalogModel(known, model);
    return !!entry && entry.enabled !== false;
  };
  const projectModel = splitModel(project?.defaultModel);
  const globalModel = splitModel(settings?.defaultModel);
  const useProject = runnable(projectModel) || (!!projectModel && !runnable(globalModel));
  const model = useProject ? projectModel : globalModel;
  let variant = !model ? null
    : useProject ? text(project?.defaultVariant) ?? (sameModel(projectModel, globalModel) ? text(settings?.defaultVariant) : null)
      : text(settings?.defaultVariant);
  const entry = model && known ? findCatalogModel(known, model) : null;
  if (variant && entry && !(entry.variants ?? []).some((offered) => offered?.id === variant)) variant = null;
  return {
    providerID: model?.providerID ?? null,
    modelID: model?.modelID ?? null,
    variant,
    agent: text(project?.defaultAgent) ?? text(settings?.defaultAgent),
  };
};

interface ScopeDefaultSettings extends SessionDefaultSettings {
  chatsDefaultAgent?: unknown;
  chatsDefaultModel?: unknown;
  chatsDefaultVariant?: unknown;
  projects?: unknown;
}

export const createReadSessionDefaults = ({ readSettings, sanitizeProjects, chatsScopeID }: {
  readSettings: () => Promise<ScopeDefaultSettings | null | undefined>;
  sanitizeProjects: (projects: ScopeDefaultSettings['projects']) => ReadonlyArray<SessionDefaultSettings & { id: string }> | undefined;
  chatsScopeID: string;
}) => async (projectID: string, catalog: readonly ModelInfo[] | null = null) => {
  const settings = (await readSettings()) ?? null;
  const project = projectID === chatsScopeID
    ? readChatsDefaults(settings)
    : (sanitizeProjects(settings?.projects || []) ?? []).find((entry) => entry.id === projectID) ?? null;
  return resolveSessionDefaults({ settings, project, catalog });
};
