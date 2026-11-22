import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['web/dist/**', 'work/**', 'node_modules/**'],
  },
  {
    // 后端与工具脚本:高价值错误规则,不做风格约束;前端不在本计划范围。
    files: ['src/**/*.mjs', 'scripts/*.mjs', 'electron/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'error',
      'no-use-before-define': ['error', { functions: false }],
    },
  },
  {
    // preload 运行在沙箱化的渲染进程里，只能用 CJS 与有限的 Electron API。
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 测试代码:require-atomic-updates 对测试轮询写法误报率高,仅对 src 启用。
    files: ['src/tests/**/*.mjs'],
    rules: {
      'require-atomic-updates': 'off',
    },
  },
  ...pluginVue.configs['flat/essential'].map((cfg) => ({
    ...cfg,
    files: cfg.files ? cfg.files.map((p) => (p.startsWith('web/src/') ? p : `web/src/${p}`)) : ['web/src/**/*.{ts,vue}'],
  })),
  {
    // 前端 TS 文件：使用 typescript-eslint parser。
    files: ['web/src/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: tseslint.parser,
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // 前端 Vue SFC：vue-eslint-parser 嵌套 typescript-eslint 解析 <script setup lang="ts">。
    files: ['web/src/**/*.vue'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'vue/html-button-has-type': 'error',
      'vue/no-unused-vars': ['error', { ignorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
    },
  },
];
