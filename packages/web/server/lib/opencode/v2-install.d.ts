export function supportsOpenCodeV2Install(platform?: NodeJS.Platform): boolean;
export function installOpenCodeV2(options?: {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  tarCommand?: string;
}): Promise<string>;
