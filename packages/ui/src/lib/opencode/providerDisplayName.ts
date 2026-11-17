export const withZenName = <T extends { id: string; name: string }>(provider: T): T =>
  provider.id === "opencode" ? { ...provider, name: "OpenCode Zen" } : provider
