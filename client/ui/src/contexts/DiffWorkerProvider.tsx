import React, { useMemo, useEffect } from 'react';
import type { SupportedLanguages } from '@pierre/diffs';
import { WorkerPoolManager } from '@pierre/diffs/worker';

import { useOptionalThemeSystem } from './useThemeSystem';
import { workerFactory } from '@/lib/diff/workerFactory';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
// NOTE: keep provider lightweight; avoid main-thread diff parsing here.

// Preload common languages for faster initial diff rendering
const PRELOAD_LANGS: SupportedLanguages[] = [
  // Keep small; workers load others on-demand.
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'markdown',
];

interface DiffWorkerProviderProps {
  children: React.ReactNode;
}

type WorkerPoolStyle = 'unified' | 'split';

const WORKER_POOL_CONFIG: Record<WorkerPoolStyle, { poolSize: number; totalASTLRUCacheSize: number; lineDiffType: 'none' | 'word-alt' }> = {
  unified: {
    poolSize: 1,
    totalASTLRUCacheSize: 24,
    lineDiffType: 'none',
  },
  split: {
    poolSize: 2,
    totalASTLRUCacheSize: 56,
    lineDiffType: 'word-alt',
  },
};

let unifiedWorkerPool: WorkerPoolManager | undefined;
let splitWorkerPool: WorkerPoolManager | undefined;

const createWorkerPool = (style: WorkerPoolStyle) => {
  const config = WORKER_POOL_CONFIG[style];
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      poolSize: config.poolSize,
      totalASTLRUCacheSize: config.totalASTLRUCacheSize,
    },
    {
      theme: {
        light: 'pierre-light',
        dark: 'pierre-dark',
      },
      langs: PRELOAD_LANGS,
      lineDiffType: config.lineDiffType,
      preferredHighlighter: 'shiki-wasm',
    }
  );
  void pool.initialize();
  return pool;
};

const getWorkerPool = (style: WorkerPoolStyle): WorkerPoolManager | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  if (style === 'split') {
    splitWorkerPool ??= createWorkerPool('split');
    return splitWorkerPool;
  }

  unifiedWorkerPool ??= createWorkerPool('unified');
  return unifiedWorkerPool;
};

const WorkerPoolWarmup: React.FC<{
  children: React.ReactNode;
  renderTheme: { light: string; dark: string };
}> = ({ children, renderTheme }) => {
  const unifiedPool = useWorkerPool('unified');
  const splitPool = useWorkerPool('split');

  useEffect(() => {
    if (unifiedPool) {
      void unifiedPool.setRenderOptions({
        theme: renderTheme,
        lineDiffType: WORKER_POOL_CONFIG.unified.lineDiffType,
      });
    }
    if (splitPool) {
      void splitPool.setRenderOptions({
        theme: renderTheme,
        lineDiffType: WORKER_POOL_CONFIG.split.lineDiffType,
      });
    }
  }, [renderTheme, splitPool, unifiedPool]);

  return <>{children}</>;
};

export const DiffWorkerProvider: React.FC<DiffWorkerProviderProps> = ({ children }) => {
  const themeSystem = useOptionalThemeSystem();

  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  const lightThemeId = themeSystem?.lightThemeId ?? fallbackLight.metadata.id;
  const darkThemeId = themeSystem?.darkThemeId ?? fallbackDark.metadata.id;

  const lightTheme =
    themeSystem?.availableThemes.find((theme) => theme.metadata.id === lightThemeId) ??
    fallbackLight;
  const darkTheme =
    themeSystem?.availableThemes.find((theme) => theme.metadata.id === darkThemeId) ??
    fallbackDark;

  ensurePierreThemeRegistered(lightTheme);
  ensurePierreThemeRegistered(darkTheme);

  const renderTheme = useMemo(
    () => ({
      light: lightTheme.metadata.id,
      dark: darkTheme.metadata.id,
    }),
    [darkTheme.metadata.id, lightTheme.metadata.id],
  );

  return (
    <WorkerPoolWarmup renderTheme={renderTheme}>
      {children}
    </WorkerPoolWarmup>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWorkerPool = (style: WorkerPoolStyle = 'unified'): WorkerPoolManager | undefined => {
  return useMemo(() => getWorkerPool(style), [style]);
};
