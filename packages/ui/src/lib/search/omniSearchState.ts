import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { decodeOmniFlag, parseOmniQuery, setOmniFlag, tokenizeOmniQuery, type OmniFilters, type OmniFlagKey } from './omniQuery';

type OmniSearchSurface = 'sidebar' | 'archive' | 'palette';
type OmniSearchDefaults = Partial<Pick<OmniFilters, 'lifecycle' | 'searchIn' | 'author'>>;
type OmniSearchProject = { value: string; label: string };
/** The words in the box and the filters shown as chips. */
type OmniSearchState = { text: string; filters: OmniFilters };

const FILTER_KEYS = ['category', 'lifecycle', 'project', 'worktree', 'author', 'searchIn'] as const satisfies readonly OmniFlagKey[];
const storageKey = (surface: OmniSearchSurface) => `openchamber.search.filters.v1.${surface}`;

const withFilter = <K extends OmniFlagKey>(filters: OmniFilters, key: K, value: OmniFilters[K]): OmniFilters => ({ ...filters, [key]: value });

export const absorbTypedFilters = (text: string, filters: OmniFilters, { commit }: { commit?: boolean } = {}): OmniSearchState => {
  const tokens = tokenizeOmniQuery(text);
  const absorbThrough = commit || /\s$/u.test(text) ? tokens.length : tokens.length - 1;
  let nextFilters = filters;
  const remaining: string[] = [];

  for (const [index, token] of tokens.entries()) {
    const decoded = index < absorbThrough ? decodeOmniFlag(token) : null;
    if (decoded) nextFilters = withFilter(nextFilters, decoded.key, decoded.value);
    else remaining.push(token);
  }

  const remainingText = remaining.join(' ');
  return { text: !commit && /\s$/u.test(text) && remainingText ? `${remainingText} ` : remainingText, filters: nextFilters };
};

const hasAbsorbedTypedFilter = (text: string, commit: boolean | undefined): boolean => {
  const tokens = tokenizeOmniQuery(text);
  const absorbThrough = commit || /\s$/u.test(text) ? tokens.length : tokens.length - 1;
  return tokens.some((token, index) => index < absorbThrough && decodeOmniFlag(token) !== null);
};

export const withoutDefaults = (filters: OmniFilters, defaults: OmniSearchDefaults): OmniFilters => {
  const result = { ...filters };
  for (const key of ['lifecycle', 'searchIn', 'author'] as const) {
    if (result[key] === defaults[key]) delete result[key];
  }
  return result;
};

export const omniQueryString = (text: string, filters: OmniFilters): string => {
  let query = text;
  for (const key of FILTER_KEYS) {
    if (filters[key] !== undefined) query = setOmniFlag(query, key, filters[key]);
  }
  return query;
};

const withoutKey = (filters: OmniFilters, key: OmniFlagKey): OmniFilters => {
  const { [key]: _removed, ...rest } = filters;
  return rest;
};

const defaultOf = (defaults: OmniSearchDefaults, key: OmniFlagKey) => {
  if (key === 'lifecycle') return defaults.lifecycle;
  if (key === 'searchIn') return defaults.searchIn;
  if (key === 'author') return defaults.author;
  return undefined;
};

const withoutCategory = ({ category: _category, ...filters }: OmniFilters): OmniFilters => filters;

const sameFilters = (left: OmniFilters, right: OmniFilters) => FILTER_KEYS.every((key) => left[key] === right[key]);

export const readRememberedFilters = (surface: OmniSearchSurface): OmniFilters => {
  try {
    const stored = getDeferredSafeStorage().getItem(storageKey(surface));
    return stored === null ? {} : withoutCategory(parseOmniQuery(stored).filters);
  } catch {
    return {};
  }
};

export const rememberFilters = (surface: OmniSearchSurface, filters: OmniFilters) => {
  try {
    getDeferredSafeStorage().setItem(storageKey(surface), omniQueryString('', withoutCategory(filters)));
  } catch {
    // Search still works when storage is unavailable.
  }
};

// An empty list is a list still loading, unless the server confirmed it.
const pruneStaleProject = (filters: OmniFilters, projects: readonly OmniSearchProject[] | undefined, confirmed: boolean): OmniFilters => {
  if (!filters.project || !projects || (!projects.length && !confirmed)) return filters;
  const normalizedProject = normalizePath(filters.project);
  const projectLabel = filters.project.toLocaleLowerCase();
  const exists = projects.some((project) => normalizedProject === normalizePath(project.value) || project.label.toLocaleLowerCase() === projectLabel);
  if (exists) return filters;
  const { project: _project, ...remainingFilters } = filters;
  return remainingFilters;
};

type UseOmniSearchStateOptions = { surface: OmniSearchSurface; defaults: OmniSearchDefaults; projects?: readonly OmniSearchProject[] };

export const useOmniSearchState = ({ surface, defaults: givenDefaults, projects }: UseOmniSearchStateOptions) => {
  // Callers pass defaults inline; key them by value so the setters stay stable.
  const { lifecycle, searchIn, author } = givenDefaults;
  const defaults = useMemo<OmniSearchDefaults>(() => ({ lifecycle, searchIn, author }), [author, lifecycle, searchIn]);
  const projectsConfirmed = useProjectsStore((store) => store.hasServerSnapshot);
  const [state, setState] = useState(() => {
    const remembered = readRememberedFilters(surface);
    const filters = withoutDefaults(pruneStaleProject(remembered, projects, projectsConfirmed), defaults);
    if (filters.project !== remembered.project) rememberFilters(surface, filters);
    return { text: '', filters };
  });

  const persist = useCallback((filters: OmniFilters) => rememberFilters(surface, withoutDefaults(filters, defaults)), [defaults, surface]);

  // Projects usually arrive after the first render; prune once they are known.
  useEffect(() => {
    setState((current) => {
      const filters = pruneStaleProject(current.filters, projects, projectsConfirmed);
      if (filters === current.filters) return current;
      persist(filters);
      return { ...current, filters };
    });
  }, [persist, projects, projectsConfirmed]);

  const setText = useCallback((text: string, options: { commit?: boolean } = {}) => {
    setState((current) => {
      const next = absorbTypedFilters(text, current.filters, options);
      if (hasAbsorbedTypedFilter(text, options.commit) && !sameFilters(next.filters, current.filters)) persist(next.filters);
      return next;
    });
  }, [persist]);

  const setFilter = useCallback(<K extends OmniFlagKey>(key: K, value: OmniFilters[K] | null) => {
    setState((current) => {
      const isDefault = value === defaultOf(defaults, key);
      const filters = value === null || isDefault ? withoutKey(current.filters, key) : withFilter(current.filters, key, value);
      if (!sameFilters(filters, current.filters)) persist(filters);
      return { ...current, filters };
    });
  }, [defaults, persist]);

  const removeFilter = useCallback((key: OmniFlagKey) => setFilter(key, null), [setFilter]);
  const clearAll = useCallback(() => {
    setState(() => {
      persist({});
      return { text: '', filters: {} };
    });
  }, [persist]);
  const clearText = useCallback(() => setState((current) => ({ ...current, text: '' })), []);
  const query = useMemo(() => omniQueryString(state.text, state.filters), [state.filters, state.text]);

  return { ...state, query, setText, setFilter, removeFilter, clearAll, clearText };
};
