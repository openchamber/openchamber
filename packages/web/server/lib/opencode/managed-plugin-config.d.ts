export function appendManagedPlugin(
  rawConfig: string | undefined,
  pluginDirectory: string,
  purpose: string,
): string;

export function appendManagedPermissions(
  rawConfig: string | undefined,
  rules: Array<{ action: string; resource: string; effect: string }>,
): string;

export function appendManagedSkills(
  rawConfig: string | undefined,
  directories: string[],
): string;

export function appendManagedCommand(
  rawConfig: string | undefined,
  name: string,
  command: { description: string; template: string },
): string;

export function appendManagedPolicies(
  rawConfig: string | undefined,
  policies: Array<{ action: string; resource: string; effect: string }>,
): string;
