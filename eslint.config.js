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
    files: ['**/*.{js,ts,tsx}'],
    ignores: ['packages/web/server/lib/platform.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "BinaryExpression[left.object.name='process'][left.property.name='platform'][right.value='win32']",
          message: 'Use IS_WIN from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
        {
          selector:
            "BinaryExpression[left.object.name='process'][left.property.name='platform'][right.value='darwin']",
          message: 'Use IS_MAC from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
        {
          selector:
            "BinaryExpression[left.object.name='process'][left.property.name='platform'][right.value='linux']",
          message: 'Use IS_LINUX from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
        {
          selector:
            "BinaryExpression[left.value='win32'][right.object.name='process'][right.property.name='platform']",
          message: 'Use IS_WIN from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
        {
          selector:
            "BinaryExpression[left.value='darwin'][right.object.name='process'][right.property.name='platform']",
          message: 'Use IS_MAC from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
        {
          selector:
            "BinaryExpression[left.value='linux'][right.object.name='process'][right.property.name='platform']",
          message: 'Use IS_LINUX from packages/web/server/lib/platform.ts instead of raw process.platform checks.',
        },
      ],
    },
  },
])
