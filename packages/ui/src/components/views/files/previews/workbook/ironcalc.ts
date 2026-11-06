// Loaded on the first edit of a workbook with formulas, so the engine costs
// nothing until then. Bundled with the app: a CDN would break offline use.
import init, { Model } from '@ironcalc/wasm';
import wasmUrl from '@ironcalc/wasm/wasm_bg.wasm?url';

let ready: Promise<unknown> | null = null;

export const loadIronCalc = async (): Promise<typeof Model> => {
  ready ??= init({ module_or_path: wasmUrl });
  await ready;
  return Model;
};
