let pending;

export const loadOpenAI = () => {
  pending ??= import('openai').then((module) => module.default);
  return pending;
};
