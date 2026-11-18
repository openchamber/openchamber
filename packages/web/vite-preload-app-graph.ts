import type { Plugin } from 'vite';

type Bundle = Record<string, { type: 'asset' } | { type: 'chunk'; imports: string[] }>;

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

export const chunkHasModule = (modules: object, moduleId: string): boolean => {
  const target = moduleId.replace(/\\/g, '/');
  return Object.keys(modules).some((id) => id.replace(/\\/g, '/') === target);
};

export const preloadScript = (hrefs: readonly string[], protocols: readonly string[]): string =>
  `if(${JSON.stringify(protocols)}.indexOf(location.protocol)!==-1){${JSON.stringify(hrefs)}.forEach(function(h){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=h;document.head.appendChild(l)})}`;

export const preloadAppGraph = (options: {
  appModule: string;
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
        const app = Object.values(bundle).find((chunk) => chunk.type === 'chunk' && chunkHasModule(chunk.modules, options.appModule));
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
