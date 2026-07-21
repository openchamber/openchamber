import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type SidebarRuntimeContext = {
  runtimeKey: string;
  generation: number;
};

let sidebarRuntimeGeneration = 0;

export const captureSidebarRuntimeContext = (): SidebarRuntimeContext => ({
  runtimeKey: getRuntimeKey(),
  generation: sidebarRuntimeGeneration,
});

export const isSidebarRuntimeContextCurrent = (context: SidebarRuntimeContext): boolean => (
  context.runtimeKey === getRuntimeKey() && context.generation === sidebarRuntimeGeneration
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey !== detail.previousRuntimeKey) {
      sidebarRuntimeGeneration += 1;
    }
  });
}
