export function appendManagedPolicies(
  rawConfig: string | undefined,
  policies: Array<{ action: string; resource: string; effect: string }>,
): string;
