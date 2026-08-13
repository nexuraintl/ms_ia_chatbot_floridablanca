import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),

  // Código del widget: corre en el navegador.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // Servidor de Cloud Run, pruebas y configuración de build: corren en Node.
  // Necesitan `process`, `Buffer` y demás globales que no existen en el navegador.
  {
    files: [
      'server/**/*.js',
      'tests/**/*.mjs',
      'vite.config.js',
      'eslint.config.js',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
])
