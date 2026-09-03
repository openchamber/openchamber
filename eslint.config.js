import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist', '.openchamber']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Runtime JavaScript (guardian, server, CLI) — plain ESM, not covered by
    // the TypeScript/TSX config above. `node --check` validates syntax only;
    // this block adds the recommended JS rule set so the guardian/bin/opencode
    // runtime JS is statically linted, not just parsed.
    files: ['packages/web/server/lib/guardian/**/*.js', 'packages/web/server/lib/opencode/**/*.js', 'packages/web/bin/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
