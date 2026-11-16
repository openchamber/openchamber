/**
 * OpenCode names its Zen provider "OpenCode", or "<workspace> / OpenCode" after
 * an OpenCode Console sign-in, which reads as a duplicate of "OpenCode Go" next
 * to it. Every surface shows it as OpenCode Zen; the workspace stays visible on
 * the provider's Console account.
 */
export const withZenName = <T extends { id: string; name: string }>(provider: T): T =>
  provider.id === "opencode" ? { ...provider, name: "OpenCode Zen" } : provider
