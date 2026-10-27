type OpenUIModule = typeof import('./OpenUIRenderer');

let loaded: OpenUIModule | null = null;
let loading: Promise<OpenUIModule> | null = null;

function loadModule() {
  // Upstream opt-out must precede react-lang's import (thesysdev/openui#960).
  Reflect.set(globalThis, Symbol.for('openui.devtools.autoMount'), true);
  loading ??= import('./OpenUIRenderer').then(({ OpenUIRenderer, OpenUIProgram }) => {
    const module = { OpenUIRenderer, OpenUIProgram };
    loaded = module;
    return module;
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export const getLoadedOpenUIModule = () => loaded;
export const loadOpenUIRenderer = () => loadModule().then((module) => module.OpenUIRenderer);
export const loadOpenUIProgram = () => loadModule().then((module) => module.OpenUIProgram);
