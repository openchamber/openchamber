import React from 'react';
import { useOnDemandComponent, useOnDemandValue } from '@/hooks/useOnDemandComponent';
import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { loadProgramCheck, needsProgramCheck } from './taggedBlocks';

export function onDemand<Props extends object>(load: () => Promise<React.ComponentType<Props>>) {
  let loaded: React.ComponentType<Props> | null = null;
  const loadOnce = () => loaded ? Promise.resolve(loaded) : load().then((component) => {
    loaded = component;
    return component;
  });
  function useLoadedComponent(): React.ComponentType<Props> | null {
    const [failed, setFailed] = React.useState(false);
    const requested = useOnDemandComponent(!loaded && !failed, loadOnce, () => setFailed(true));
    return loaded ?? requested;
  }
  return Object.assign(useLoadedComponent, { load: () => importWithChunkRecovery(loadOnce, { reloadOnFailure: false }) });
}

export const useUiBlockComponent = onDemand(() => import('./UiBlock').then((module) => module.UiBlock));

export const useReplyUiBlockComponent = onDemand(() => import('./ReplyUiBlock').then((module) => module.ReplyUiBlock));

const keepCode = () => undefined;

export function useProgramCheck(text: string): void {
  useOnDemandValue(needsProgramCheck(text), loadProgramCheck, keepCode);
}
