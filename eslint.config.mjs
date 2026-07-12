import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts'],
  extends: [
    ...tseslint.configs.recommendedTypeChecked,
  ],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  linterOptions: {
    reportUnusedDisableDirectives: 0,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
});
