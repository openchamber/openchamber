import path from 'node:path';
import { build, type InlineConfig, type Plugin, type PluginOption } from 'vite';

import { SHARE_DOCUMENT_ENTRY, SHARE_DOCUMENT_SHIMS } from '../ui/src/share-document/shims';


export const SHARE_DOCUMENT_FILE = 'share-document.js';

type Options = {
  uiSource: string;
  aliases: { find: string | RegExp; replacement: string }[];
  react: () => PluginOption;
};

const stripExtension = (file: string) => file.replace(/\.(tsx?|jsx?)$/, '');

// The app's stores read localStorage when their module loads, and the viewer's opaque-origin frame throws on that read, so a store in the bundle leaves every shared page blank.
const posix = (file: string) => file.replace(/\\/g, '/');

export function appStoreModules(moduleIds: string[], uiSource: string): string[] {
  const stores = `${posix(uiSource)}/stores/`;
  return moduleIds.filter((id) => posix(id).startsWith(stores));
}

export function shareDocumentShim(resolvedId: string, uiSource: string, windows = process.platform === 'win32'): string | null {
  const slashes = (file: string) => (windows ? posix(file) : file);
  const root = slashes(uiSource).replace(/\/$/, '');
  const target = stripExtension(slashes(resolvedId).split('?')[0]);
  for (const [from, shim] of Object.entries(SHARE_DOCUMENT_SHIMS)) {
    if (target === `${root}/${from}`) return `${root}/${shim}`;
  }
  return null;
}

function shimPlugin(uiSource: string): Plugin {
  return {
    name: 'openchamber-share-document-shims',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return shareDocumentShim(resolved.id, uiSource);
    },
  };
}

async function buildShareDocument({ uiSource, aliases, react }: Options): Promise<string> {
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
  const stores = appStoreModules(Object.keys(chunk.modules), uiSource);
  if (stores.length > 0) {
    throw new Error(`The share document bundles app stores, which break shared pages at load: ${stores.map((id) => path.relative(uiSource, id)).join(', ')}. Replace the import that pulls them in with a shim in share-document/shims.ts.`);
  }
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
