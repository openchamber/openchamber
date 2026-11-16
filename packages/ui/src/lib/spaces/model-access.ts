
type SpaceModelProvider = {
  id: string;
  upstream: string;
  envName: string;
};

export const SPACE_MODEL_PROVIDERS: readonly SpaceModelProvider[] = [
  { id: 'anthropic', upstream: 'https://api.anthropic.com/v1', envName: 'ANTHROPIC_API_KEY' },
  { id: 'google', upstream: 'https://generativelanguage.googleapis.com/v1beta', envName: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  { id: 'openai', upstream: 'https://api.openai.com/v1', envName: 'OPENAI_API_KEY' },
  { id: 'openrouter', upstream: 'https://openrouter.ai/api/v1', envName: 'OPENROUTER_API_KEY' },
  { id: 'groq', upstream: 'https://api.groq.com/openai/v1', envName: 'GROQ_API_KEY' },
  { id: 'mistral', upstream: 'https://api.mistral.ai/v1', envName: 'MISTRAL_API_KEY' },
  { id: 'deepseek', upstream: 'https://api.deepseek.com/v1', envName: 'DEEPSEEK_API_KEY' },
  { id: 'xai', upstream: 'https://api.x.ai/v1', envName: 'XAI_API_KEY' },
];

export const SPACE_LOGIN_NAMES: ReadonlyMap<string, string> = new Map([['openai', 'ChatGPT'], ['github-copilot', 'GitHub Copilot']]);

export const SPACE_LOGIN_ONLY_PROVIDERS: readonly string[] = Array.from(SPACE_LOGIN_NAMES.keys()).filter((id) => !SPACE_MODEL_PROVIDERS.some((provider) => provider.id === id));

export const isSpaceGrantableProvider = (providerId: string): boolean => SPACE_MODEL_PROVIDERS.some((provider) => provider.id === providerId) || SPACE_LOGIN_NAMES.has(providerId);
