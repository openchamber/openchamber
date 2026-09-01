export const getProjectPathLabel = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized === '/') return 'Root';
  return normalized.split('/').filter(Boolean).pop() || normalized;
};

export const getProjectDisplayLabel = (project: { label?: string | null; path: string }): string => (
  project.label?.trim() || getProjectPathLabel(project.path)
);
