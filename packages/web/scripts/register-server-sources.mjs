import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const roots = ['server', 'bin'].map((folder) => fileURLToPath(new URL(`../${folder}/`, import.meta.url)));

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.endsWith('.js')) throw error;
      let candidate;
      try {
        candidate = fs.realpathSync(fileURLToPath(error.url).replace(/\.js$/, '.ts'));
      } catch {
        throw error;
      }
      if (!roots.some((root) => candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`))) throw error;
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  },
});
