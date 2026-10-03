// The model providers a space can be given a key for, and what the create dialog needs to know
// about each: the API the gatekeeper's window forwards to, and the environment variable a key is
// usually kept in on the host. The list is the server's (`provider_not_supported` refuses any
// other, see "Grants" in `packages/web/server/lib/spaces/DOCUMENTATION.md`); OpenCode 2's catalog
// carries neither the API address nor the variable name, so both are the defaults of each
// provider's own SDK, which is what OpenCode inside talks to through the window.

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
