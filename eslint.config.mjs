import js from '@eslint/js';
import globals from 'globals';

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
];
