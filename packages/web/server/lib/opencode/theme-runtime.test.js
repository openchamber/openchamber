import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import nativeFsPromises from 'node:fs/promises';

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
    open: async (filePath) => {
      const stat = stats[filePath];
      if (!stat) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
      const content = Buffer.from(files[filePath] ?? '', 'utf8');
      return {
        stat: async () => stat,
        read: async (buffer, offset, length, position) => {
          const slice = content.subarray(position, position + length);
          buffer.set(slice, offset);
          return { bytesRead: slice.length, buffer };
        },
        close: async () => {},
      };
    },
  },
  path: { join: (...parts) => parts.join('/') },
  themesDir: '/themes',
  maxThemeJsonBytes: 512 * 1024,
  logger: { warn: () => {} },
});

describe('theme runtime', () => {
  describe('readCustomThemesFromDisk', () => {
    it('loads compact authored roles without requiring derived colors', async () => {
      const theme = validTheme('compact');
      theme.colors.primary = { base: '#ffffff' };
      theme.colors.interactive = { border: '#444444' };
      theme.colors.status = { error: '#ff0000', warning: '#ffaa00', success: '#00ff00', info: '#0000ff' };
      delete theme.colors.syntax.highlights;
      delete theme.colors.syntax.base.background;
      delete theme.colors.syntax.base.foreground;
      const runtime = createTestRuntime({
        entries: [fileEntry('compact.json'), fileEntry('bad.json')],
        files: { '/themes/compact.json': JSON.stringify(theme), '/themes/bad.json': '{broken' },
        stats: { '/themes/compact.json': { isFile: () => true, size: 1024 }, '/themes/bad.json': { isFile: () => true, size: 10 } },
      });
      expect((await runtime.readCustomThemesFromDisk()).map((item) => item.metadata.id)).toEqual(['compact']);
    });
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

    it.skipIf(process.platform === 'win32')('loads other themes when a symlinked theme points to a FIFO', async () => {
      const themesDir = await nativeFsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-theme-fifo-'));
      try {
        const fifoPath = path.join(themesDir, 'theme.fifo');
        execFileSync('mkfifo', [fifoPath]);
        await nativeFsPromises.symlink(fifoPath, path.join(themesDir, 'blocked.json'));
        await nativeFsPromises.writeFile(path.join(themesDir, 'valid.json'), JSON.stringify(validTheme('valid-theme')));
        const runtime = createThemeRuntime({
          fsPromises: nativeFsPromises,
          path,
          themesDir,
          maxThemeJsonBytes: 512 * 1024,
          logger: { warn: () => {} },
        });

        const themes = await Promise.race([
          runtime.readCustomThemesFromDisk(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('theme loading blocked on FIFO open')), 3000)),
        ]);

        expect(themes.map((theme) => theme.metadata.id)).toEqual(['valid-theme']);
      } finally {
        await nativeFsPromises.rm(themesDir, { recursive: true, force: true });
      }
    });

    it('refuses a stat-small/read-huge theme without buffering it whole', async () => {
      // The path stat claims 1024 bytes, but the opened file actually holds a
      // valid theme padded past the cap: the in-flight read must refuse it
      // exactly like an already-over-cap file, serving at most cap + 1 bytes.
      const cap = 512 * 1024;
      const padded = validTheme('padded-theme');
      padded.metadata.description = 'x'.repeat(cap);
      const content = JSON.stringify(padded);
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(cap);
      let servedBytes = 0;
      const runtime = createThemeRuntime({
        fsPromises: {
          readdir: async () => [fileEntry('padded.json')],
          stat: async () => ({ isFile: () => true, size: 1024 }),
          readFile: async () => content,
          open: async () => {
            const bytes = Buffer.from(content, 'utf8');
            return {
              stat: async () => ({ isFile: () => true, size: 1024 }),
              read: async (buffer, offset, length, position) => {
                const slice = bytes.subarray(position, position + length);
                buffer.set(slice, offset);
                servedBytes += slice.length;
                return { bytesRead: slice.length, buffer };
              },
              close: async () => {},
            };
          },
        },
        path: { join: (...parts) => parts.join('/') },
        themesDir: '/themes',
        maxThemeJsonBytes: cap,
        logger: { warn: () => {} },
      });

      expect(await runtime.readCustomThemesFromDisk()).toEqual([]);
      expect(servedBytes).toBeLessThanOrEqual(cap + 1);
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
