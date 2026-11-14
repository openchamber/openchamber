import path from 'node:path';
import { build, type InlineConfig, type Plugin, type PluginOption } from 'vite';

import { SHARE_DOCUMENT_ENTRY, SHARE_DOCUMENT_SHIMS } from '../ui/src/share-document/shims';

/**
 * Builds the renderer a shared `ui` page carries (packages/ui/src/share-document)
 * as one self-contained IIFE, `share-document.js`, next to the app's assets. The
 * chat fetches it as text and inlines it into the page it hands the server, so
 * the page runs in the relay's viewer with no network. The bundle is its own
 * build: it replaces the app modules listed in SHARE_DOCUMENT_SHIMS and inlines
 * every chunk and the stylesheet, which the app's chunked build cannot do.
 *
 * In development the dev server builds it on the first request and again after
 * a source change.
 */

export const SHARE_DOCUMENT_FILE = 'share-document.js';

type Options = {
  /** packages/ui/src */
  uiSource: string;
  /** The app's aliases, so the bundle resolves imports the way the app does. */
  aliases: { find: string | RegExp; replacement: string }[];
  /** The app's React plugin, so the bundle is compiled the same way. */
  react: () => PluginOption;
};

const stripExtension = (file: string) => file.replace(/\.(tsx?|jsx?)$/, '');

function shimPlugin(uiSource: string): Plugin {
  const shims = new Map(Object.entries(SHARE_DOCUMENT_SHIMS).map(([target, shim]) => [
    path.join(uiSource, target),
    path.join(uiSource, shim),
  ]));
  return {
    name: 'openchamber-share-document-shims',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return shims.get(stripExtension(resolved.id.split('?')[0])) ?? null;
    },
  };
}

async function buildShareDocument({ uiSource, aliases, react }: Options): Promise<string> {
  // The React plugin compiles JSX for the mode Vite runs in (development under
  // the dev server), so React's own build has to match it: production React
  // has no jsxDEV for development JSX.
  const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const config: InlineConfig = {
    configFile: false,
    root: uiSource,
    logLevel: 'warn',
    mode,
    plugins: [shimPlugin(uiSource), react()],
    resolve: { alias: aliases },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env': {},
      global: 'globalThis',
    },
    build: {
      write: false,
      emptyOutDir: false,
      minify: mode === 'production',
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: path.join(uiSource, SHARE_DOCUMENT_ENTRY),
        formats: ['iife'],
        name: 'OpenChamberShareDocument',
        fileName: () => SHARE_DOCUMENT_FILE,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  };
  const result = await build(config);
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => ('output' in entry ? entry.output : []));
  const chunk = outputs.find((output) => output.type === 'chunk' && output.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error('The share document build produced no script');
  return chunk.code;
}

export function shareDocumentPlugin(options: Options): Plugin {
  let cached: Promise<string> | null = null;
  const bundle = () => {
    cached ??= buildShareDocument(options).catch((error) => {
      cached = null;
      throw error;
    });
    return cached;
  };
  return {
    name: 'openchamber-share-document',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: SHARE_DOCUMENT_FILE, source: await buildShareDocument(options) });
    },
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.startsWith(options.uiSource)) cached = null;
      });
      server.middlewares.use(`/${SHARE_DOCUMENT_FILE}`, (_request, response) => {
        bundle().then((code) => {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(code);
        }, (error) => {
          server.config.logger.error(`[share-document] ${error instanceof Error ? error.message : String(error)}`);
          response.statusCode = 500;
          response.end();
        });
      });
    },
  };
}
