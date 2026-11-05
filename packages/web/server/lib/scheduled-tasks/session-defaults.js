/**
 * The model, thinking level and agent a new session starts with, as Settings
 * and the project define them: the project's own default first, then the
 * global one. A task in the Chats scope takes the Chats defaults in the
 * project's place. A thinking level travels with the model it was set next to.
 * Anything unset is null, and OpenCode then applies its own default.
 */
const splitModel = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
};

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const resolveSessionDefaults = ({ settings, project, chats = false }) => {
  const scope = chats
    ? { defaultModel: settings?.chatsDefaultModel, defaultVariant: settings?.chatsDefaultVariant, defaultAgent: settings?.chatsDefaultAgent }
    : project;
  const scopeModel = splitModel(scope?.defaultModel);
  const globalModel = splitModel(settings?.defaultModel);
  const model = scopeModel ?? globalModel;
  const variant = scopeModel ? text(scope?.defaultVariant) : globalModel ? text(settings?.defaultVariant) : null;
  return {
    providerID: model?.providerID ?? null,
    modelID: model?.modelID ?? null,
    variant,
    agent: text(scope?.defaultAgent) ?? text(settings?.defaultAgent),
  };
};
