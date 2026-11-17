import { getRuntimeKey } from '@/lib/runtime-switch';

export type ConfigRuntimeContext = { runtimeKey: string; generation: number };

export const configRuntime = { generation: 0, instanceGeneration: 0 };

export const captureConfigRuntimeContext = (): ConfigRuntimeContext => ({
    runtimeKey: getRuntimeKey(),
    generation: configRuntime.generation,
});

export const isConfigRuntimeContextCurrent = (context: ConfigRuntimeContext): boolean => (
    context.generation === configRuntime.generation && context.runtimeKey === getRuntimeKey()
);

export const isSameConfigRuntimeContext = (left: ConfigRuntimeContext, right: ConfigRuntimeContext): boolean => (
    left.runtimeKey === right.runtimeKey && left.generation === right.generation
);
