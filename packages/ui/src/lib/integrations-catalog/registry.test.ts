import { describe, expect, test } from 'bun:test';

import {
  CATALOG_CATEGORY_ORDER,
  CATALOG_ENTRIES,
  catalogEntryHasAllInputs,
  catalogMcpComponent,
  catalogPluginPackageName,
  getCatalogEntry,
  interpolateCatalogTokens,
} from './registry';

describe('integrations catalog registry', () => {
  test('ids are unique and kebab-case', () => {
    const ids = CATALOG_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)).toBe(true);
    }
  });

  test('every entry bundles at least one component', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.components.length).toBeGreaterThan(0);
    }
  });

  test('an entry carries at most one mcp component, whose name is the entry id', () => {
    for (const entry of CATALOG_ENTRIES) {
      const mcpComponents = entry.components.filter((component) => component.kind === 'mcp');
      expect(mcpComponents.length).toBeLessThanOrEqual(1);
      if (mcpComponents.length === 1) {
        expect(catalogMcpComponent(entry)?.kind).toBe('mcp');
      }
    }
  });

  test('every mcp component has exactly one of remote or local, and it is valid', () => {
    for (const entry of CATALOG_ENTRIES) {
      const mcp = catalogMcpComponent(entry);
      if (!mcp) continue;
      const hasRemote = Boolean(mcp.remote);
      const hasLocal = Boolean(mcp.local);
      expect(hasRemote || hasLocal).toBe(true);
      expect(hasRemote && hasLocal).toBe(false);
      if (mcp.remote) {
        expect(/^https:\/\//.test(mcp.remote.url)).toBe(true);
        if (mcp.auth === 'token') {
          expect(mcp.remote.tokenHeader).toBeDefined();
          expect(/^https:\/\//.test(mcp.tokenHelpUrl ?? '')).toBe(true);
        }
      }
      if (mcp.local) {
        expect(mcp.local.command.length).toBeGreaterThan(0);
        expect(mcp.local.command[0].includes('{')).toBe(false);
        expect(mcp.auth).toBe('none');
      }
    }
  });

  test('every category referenced by an entry is part of the filter order', () => {
    for (const entry of CATALOG_ENTRIES) {
      for (const category of entry.categories) {
        expect(CATALOG_CATEGORY_ORDER).toContain(category);
      }
    }
    expect(CATALOG_CATEGORY_ORDER[0]).toBe('product');
  });

  test('plugin components pin a major version and resolve to their package name', () => {
    for (const entry of CATALOG_ENTRIES) {
      for (const component of entry.components) {
        if (component.kind !== 'plugin') continue;
        expect(/^@?[a-z0-9-][a-z0-9./-]*@\^\d+$/.test(component.spec)).toBe(true);
        expect(catalogPluginPackageName(component.spec)).toBe(component.spec.split('@^')[0]);
      }
    }
  });

  test('skill components point into a git source with a subpath', () => {
    for (const entry of CATALOG_ENTRIES) {
      for (const component of entry.components) {
        if (component.kind !== 'skill') continue;
        expect(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(component.source)).toBe(true);
        // Vendors keep skills under `skills/`, `plugins/<name>/skills/` or
        // `src/skills/`; the installer takes any repo-relative folder.
        expect(component.subpath.startsWith('/') || component.subpath.split('/').includes('..')).toBe(false);
        expect(component.subpath.split('/').at(-1)).toBe(component.skillDir);
      }
    }
  });

  test('token interpolation keeps unfilled placeholders and fills provided values', () => {
    expect(interpolateCatalogTokens('https://aws-mcp.{region}.api.aws/mcp', { region: ' eu-central-1 ' })).toBe('https://aws-mcp.eu-central-1.api.aws/mcp');
    expect(interpolateCatalogTokens('https://aws-mcp.{region}.api.aws/mcp', {})).toBe('https://aws-mcp.{region}.api.aws/mcp');
    expect(interpolateCatalogTokens('npx -y @azure-devops/mcp {org}', { org: 'contoso' })).toBe('npx -y @azure-devops/mcp contoso');
  });

  test('required inputs block install until filled; defaults satisfy optional ones', () => {
    const aws = getCatalogEntry('aws');
    if (!aws) throw new Error('aws entry missing');
    expect(catalogEntryHasAllInputs(aws, {})).toBe(true);
    const ado = getCatalogEntry('azure-devops');
    if (!ado) throw new Error('azure-devops entry missing');
    expect(catalogEntryHasAllInputs(ado, {})).toBe(false);
    expect(catalogEntryHasAllInputs(ado, { org: 'contoso' })).toBe(true);
  });
});