import React, { useEffect, useSyncExternalStore } from 'react';
import type { SupportedLanguages } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

import { useOptionalThemeSystem } from './useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
// NOTE: keep provider lightweight; avoid main-thread diff parsing here.
// This module must not statically import `@pierre/diffs` runtime code:
// `@pierre/diffs/worker` pulls the Shiki highlighter (core + oniguruma engine
// + grammar registry) into the eager startup graph and `initialize()` spawns
// workers plus a main-thread shared highlighter before any diff is visible.
// Everything heavy loads on demand and is only warmed after startup idle.

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

type PoolModules = {
  WorkerPoolManager: typeof WorkerPoolManager;
  workerFactory: () => Worker;
  ensurePierreThemeRegistered: (theme: Theme) => void;
};

let poolModulesPromise: Promise<PoolModules> | null = null;

const loadPoolModules = (): Promise<PoolModules> => {
  poolModulesPromise ??= Promise.all([
    import('@pierre/diffs/worker'),
    import('@/lib/diff/workerFactory'),
    import('@/lib/shiki/appThemeRegistry'),
  ]).then(([workerModule, factoryModule, themeRegistryModule]) => ({
    WorkerPoolManager: workerModule.WorkerPoolManager,
    workerFactory: factoryModule.workerFactory,
    ensurePierreThemeRegistered: themeRegistryModule.ensurePierreThemeRegistered,
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

  // Register the active app themes with @pierre/diffs and forward them to any
  // live pools. Registration goes through the deferred module load so the
  // theme registry (and its @pierre/diffs import) stays out of the eager
  // startup graph; each diff surface also registers the themes it renders
  // with, so ordering is preserved even before this resolves.
  useEffect(() => {
    let cancelled = false;
    void loadPoolModules().then((modules) => {
      if (cancelled) return;
      modules.ensurePierreThemeRegistered(lightTheme);
      modules.ensurePierreThemeRegistered(darkTheme);
      setRenderTheme({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id });
    });
    return () => {
      cancelled = true;
    };
  }, [darkTheme, lightTheme]);

  // Warm the worker pools once startup work has settled so the first diff a
  // user opens does not pay worker spawn + highlighter init. Idle-deferred:
  // warming competed with initial load (3 workers, shiki grammars, oniguruma
  // wasm) when it ran during mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const warm = () => {
      ensurePool('unified');
      ensurePool('split');
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

// eslint-disable-next-line react-refresh/only-export-components
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
