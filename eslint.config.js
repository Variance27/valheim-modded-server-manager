'use strict';
// Catches the mistakes that matter most in a codebase with no way to run against a VPS here:
// names that are not defined (a missed import after moving code) and leftovers nobody uses.
const globals = require('globals');

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
};

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    rules,
  },
  {
    // Browser code. Top-level functions are called from onclick="..." in the HTML, which ESLint
    // cannot see, so only unused locals are reported there.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.browser },
    rules: { ...rules, 'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }] },
  },
];
