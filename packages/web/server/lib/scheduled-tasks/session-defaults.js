const splitModel = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
};

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const resolveSessionDefaults = ({ settings, project }) => {
  const projectModel = splitModel(project?.defaultModel);
  const globalModel = splitModel(settings?.defaultModel);
  const model = projectModel ?? globalModel;
  const variant = projectModel ? text(project?.defaultVariant) : globalModel ? text(settings?.defaultVariant) : null;
  return {
    providerID: model?.providerID ?? null,
    modelID: model?.modelID ?? null,
    variant,
    agent: text(project?.defaultAgent) ?? text(settings?.defaultAgent),
  };
};
