import { describe, expect, it } from 'vitest';

import { createThemeRuntime } from './theme-runtime.js';

const validTheme = (id = 'custom-theme') => ({
  metadata: {
    id,
    name: 'Custom Theme',
    variant: 'dark',
  },
  colors: {
    primary: {
      base: '#ffffff',
      foreground: '#000000',
    },
    surface: {
      background: '#000000',
      foreground: '#ffffff',
      muted: '#111111',
      mutedForeground: '#eeeeee',
      elevated: '#222222',
      elevatedForeground: '#dddddd',
      subtle: '#333333',
    },
    interactive: {
      border: '#444444',
      selection: '#555555',
      selectionForeground: '#ffffff',
      focusRing: '#666666',
      hover: '#777777',
    },
    status: {
      error: '#ff0000',
      errorForeground: '#ffffff',
      errorBackground: '#330000',
      errorBorder: '#660000',
      warning: '#ffaa00',
      warningForeground: '#000000',
      warningBackground: '#332200',
      warningBorder: '#664400',
      success: '#00ff00',
      successForeground: '#000000',
      successBackground: '#003300',
      successBorder: '#006600',
      info: '#0000ff',
      infoForeground: '#ffffff',
      infoBackground: '#000033',
      infoBorder: '#000066',
    },
    syntax: {
      base: {
        background: '#000000',
        foreground: '#ffffff',
        keyword: '#ff00ff',
        string: '#00ff00',
        number: '#ffaa00',
        function: '#00ffff',
        variable: '#ffffff',
        type: '#ffff00',
        comment: '#888888',
        operator: '#ffffff',
      },
      highlights: {
        diffAdded: '#003300',
        diffRemoved: '#330000',
        lineNumber: '#888888',
      },
    },
  },
});

const fileEntry = (name, type = 'file') => ({
  name,
  isFile: () => type === 'file',
  isDirectory: () => type === 'directory',
  isSymbolicLink: () => type === 'symlink',
});

const createTestRuntime = ({ entries, files, stats }) => createThemeRuntime({
  fsPromises: {
    readdir: async () => entries,
    stat: async (filePath) => stats[filePath],
    readFile: async (filePath) => files[filePath],
  },
  path: { join: (...parts) => parts.join('/') },
  themesDir: '/themes',
  maxThemeJsonBytes: 512 * 1024,
  logger: { warn: () => {} },
});

describe('theme runtime', () => {
  describe('readCustomThemesFromDisk', () => {
    it('loads valid theme files', async () => {
      const runtime = createTestRuntime({
        entries: [fileEntry('direct.json')],
        files: { '/themes/direct.json': JSON.stringify(validTheme('direct-theme')) },
        stats: { '/themes/direct.json': { isFile: () => true, size: 1024 } },
      });

      const themes = await runtime.readCustomThemesFromDisk();

      expect(themes.map((theme) => theme.metadata.id)).toEqual(['direct-theme']);
    });

    it('loads JSON themes whose directory entry is a symbolic link', async () => {
      const runtime = createTestRuntime({
        entries: [fileEntry('linked.json', 'symlink')],
        files: { '/themes/linked.json': JSON.stringify(validTheme('linked-theme')) },
        stats: { '/themes/linked.json': { isFile: () => true, size: 1024 } },
      });

      const themes = await runtime.readCustomThemesFromDisk();

      expect(themes.map((theme) => theme.metadata.id)).toEqual(['linked-theme']);
    });

    it('skips JSON directories after stat resolution', async () => {
      const runtime = createTestRuntime({
        entries: [fileEntry('directory.json', 'directory')],
        files: { '/themes/directory.json': JSON.stringify(validTheme('directory-theme')) },
        stats: { '/themes/directory.json': { isFile: () => false, size: 1024 } },
      });

      const themes = await runtime.readCustomThemesFromDisk();

      expect(themes).toEqual([]);
    });
  });
});
