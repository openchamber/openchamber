import type { Plugin } from 'vite';

/**
 * Starts fetching the desktop application's code while the document is still
 * being parsed.
 *
 * `src/main.tsx` picks the application by surface and loads it with a dynamic
 * import, so the document's own preload list ends at that import: the
 * application chunk and everything it imports are requested only after the
 * entry has run. In the packaged desktop app the entry cannot run until main
 * has answered the runtime-config script, which waits for the local server,
 * so that second round of requests started after the wait instead of during
 * it.
 *
 * The list is emitted as a script that adds the preload links only on the
 * given protocols. Over the network the same links would make a phone
 * download the desktop application it never runs.
 */
type Bundle = Record<string, { type: 'asset' } | { type: 'chunk'; imports: string[] }>;

/** Every chunk `fileName` imports statically, itself included, each once. */
export const staticImportClosure = (bundle: Bundle, fileName: string): string[] => {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const chunk = bundle[name];
    if (!chunk || chunk.type !== 'chunk') return;
    seen.add(name);
    for (const imported of chunk.imports) visit(imported);
  };
  visit(fileName);
  return [...seen];
};

export const preloadScript = (hrefs: readonly string[], protocols: readonly string[]): string =>
  `if(${JSON.stringify(protocols)}.indexOf(location.protocol)!==-1){${JSON.stringify(hrefs)}.forEach(function(h){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=h;document.head.appendChild(l)})}`;

export const preloadAppGraph = (options: {
  /** Absolute id of the module the entry imports dynamically. */
  appModule: string;
  /** The document that gets the list, by file name. */
  document: string;
  protocols: readonly string[];
}): Plugin => {
  let base = '/';
  return {
    name: 'openchamber-preload-app-graph',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const bundle = context.bundle;
        if (!bundle || !context.chunk || !context.filename.endsWith(`/${options.document}`)) return;
        const app = Object.values(bundle).find((chunk) => chunk.type === 'chunk' && Object.hasOwn(chunk.modules, options.appModule));
        if (!app) {
          this.error(`preloadAppGraph: no chunk for ${options.appModule}`);
        }
        const already = new Set(staticImportClosure(bundle, context.chunk.fileName));
        const hrefs = staticImportClosure(bundle, app.fileName)
          .filter((fileName) => !already.has(fileName))
          .map((fileName) => `${base}${fileName}`);
        return [{ tag: 'script', children: preloadScript(hrefs, options.protocols), injectTo: 'head' }];
      },
    },
  };
};
