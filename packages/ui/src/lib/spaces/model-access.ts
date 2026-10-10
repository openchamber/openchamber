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

/**
 * What the host's browser login for a provider is called on screen, for the providers whose login
 * a space can be given (the server's `LOGIN_PROVIDERS`): OpenAI's is a ChatGPT login, GitHub
 * Copilot's is its own. The `spaces.failure.login*` texts take the name as `{name}`.
 */
export const SPACE_LOGIN_NAMES: ReadonlyMap<string, string> = new Map([['openai', 'ChatGPT'], ['github-copilot', 'GitHub Copilot']]);

/**
 * The providers a space can be given only through the host's login, because they issue no key:
 * GitHub Copilot. Their row in the dialogs offers the login alone, and only while the host has one.
 */
export const SPACE_LOGIN_ONLY_PROVIDERS: readonly string[] = Array.from(SPACE_LOGIN_NAMES.keys()).filter((id) => !SPACE_MODEL_PROVIDERS.some((provider) => provider.id === id));

/** Whether a space can be given this provider at all, by key or by the host's login. */
export const isSpaceGrantableProvider = (providerId: string): boolean => SPACE_MODEL_PROVIDERS.some((provider) => provider.id === providerId) || SPACE_LOGIN_NAMES.has(providerId);
