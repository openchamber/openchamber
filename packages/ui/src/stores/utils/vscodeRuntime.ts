import type { RuntimeAPIs } from '@/lib/api/types';
import {
  getVSCodeBootstrapConfig,
  isVSCodeBootstrapPresent,
  type VSCodeBootstrapConfig,
} from '@/lib/vscodeBootstrap';

export type { VSCodeBootstrapConfig };
export { getVSCodeBootstrapConfig };

export const isVSCodeRuntime = (
  runtimeApis: RuntimeAPIs | null,
  bootstrapConfig: VSCodeBootstrapConfig | null = getVSCodeBootstrapConfig(),
): boolean => Boolean(isVSCodeBootstrapPresent(bootstrapConfig) || runtimeApis?.runtime?.isVSCode);
