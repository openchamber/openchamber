import React, { useEffect, useSyncExternalStore } from 'react';
import type { HighlighterTypes, SupportedLanguages } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

import { useOptionalThemeSystem } from './useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';

const PRELOAD_LANGS: SupportedLanguages[] = [
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

const MAIN_THREAD_MAX_CHARACTERS = 64 * 1024;

const WORKER_POOL_CONFIG: Record<WorkerPoolStyle, { poolSize: number; totalASTLRUCacheSize: number; lineDiffType: 'none' | 'word-line' }> = {
  unified: {
    poolSize: 1,
    totalASTLRUCacheSize: 24,
    lineDiffType: 'none',
  },
  split: {
    poolSize: 2,
    totalASTLRUCacheSize: 56,
    lineDiffType: 'word-line',
  },
};

type PoolModules = {
  WorkerPoolManager: typeof WorkerPoolManager;
  workerFactory: () => Worker;
  ensurePierreThemeRegistered: (theme: Theme) => string;
  highlighter: HighlighterTypes;
};

let poolModulesPromise: Promise<PoolModules> | null = null;

const loadPoolModules = (): Promise<PoolModules> => {
  poolModulesPromise ??= Promise.all([
    import('@pierre/diffs/worker'),
    import('@/lib/diff/workerFactory').then(({ workerFactory }) => workerFactory),
    import('@/lib/shiki/appThemeRegistry'),
    import('@/lib/shiki/diffsHighlighter'),
  ]).then(([workerModule, workerFactory, themeRegistryModule, highlighterModule]) => ({
    WorkerPoolManager: workerModule.WorkerPoolManager,
    workerFactory,
    ensurePierreThemeRegistered: themeRegistryModule.ensurePierreThemeRegistered,
    highlighter: highlighterModule.DIFFS_HIGHLIGHTER,
  }));
  return poolModulesPromise;
};

const pools: Partial<Record<WorkerPoolStyle, WorkerPoolManager>> = {};
const poolsRequested = new Set<WorkerPoolStyle>();
const poolListeners = new Set<() => void>();

let currentRenderTheme: { light: string; dark: string } = {
  light: 'pierre-light',
  dark: 'pierre-dark',
};

const notifyPoolListeners = () => {
  for (const listener of poolListeners) listener();
};

const applyRenderOptions = (style: WorkerPoolStyle, pool: WorkerPoolManager) => {
  void pool.setRenderOptions({
    theme: currentRenderTheme,
    lineDiffType: WORKER_POOL_CONFIG[style].lineDiffType,
  });
};

const ensurePool = (style: WorkerPoolStyle): void => {
  if (typeof window === 'undefined' || poolsRequested.has(style)) return;
  poolsRequested.add(style);
  void loadPoolModules().then((modules) => {
    if (pools[style]) return;
    const config = WORKER_POOL_CONFIG[style];
    const pool = new modules.WorkerPoolManager(
      {
        workerFactory: modules.workerFactory,
        poolSize: config.poolSize,
        totalASTLRUCacheSize: config.totalASTLRUCacheSize,
        mainThreadMaxCharacters: MAIN_THREAD_MAX_CHARACTERS,
      },
      {
        theme: {
          light: 'pierre-light',
          dark: 'pierre-dark',
        },
        langs: PRELOAD_LANGS,
        lineDiffType: config.lineDiffType,
        preferredHighlighter: modules.highlighter,
      }
    );
    void pool.initialize();
    pools[style] = pool;
    applyRenderOptions(style, pool);
    notifyPoolListeners();
  });
};

const subscribeToPools = (listener: () => void): (() => void) => {
  poolListeners.add(listener);
  return () => poolListeners.delete(listener);
};

const setRenderTheme = (renderTheme: { light: string; dark: string }) => {
  if (currentRenderTheme.light === renderTheme.light && currentRenderTheme.dark === renderTheme.dark) {
    return;
  }
  currentRenderTheme = renderTheme;
  for (const style of Object.keys(pools) as WorkerPoolStyle[]) {
    const pool = pools[style];
    if (pool) applyRenderOptions(style, pool);
  }
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

  useEffect(() => {
    let cancelled = false;
    void loadPoolModules().then((modules) => {
      if (cancelled) return;
      setRenderTheme({
        light: modules.ensurePierreThemeRegistered(lightTheme),
        dark: modules.ensurePierreThemeRegistered(darkTheme),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [darkTheme, lightTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const warm = () => {
      ensurePool('unified');
      ensurePool('split');
      void import('@/components/chat/markdown/highlightsEngine').then(({ loadHighlights }) => loadHighlights());
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timeout = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(timeout);
  }, []);

  return <>{children}</>;
};

// oxlint-disable-next-line react/only-export-components
export const useWorkerPool = (style: WorkerPoolStyle = 'unified'): WorkerPoolManager | undefined => {
  const pool = useSyncExternalStore(
    subscribeToPools,
    () => pools[style],
    () => undefined,
  );
  useEffect(() => {
    ensurePool(style);
  }, [style]);
  return pool;
};
