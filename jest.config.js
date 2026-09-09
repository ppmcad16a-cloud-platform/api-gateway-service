// Jest config for api_gateway. Unlike catalog_server/notification_server,
// there's no shared tests/ infra here — the gateway touches no database,
// so each test file is self-contained (spins up its own fake target
// servers and requires ./index fresh).
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: [
    '**/*.js',
    '!**/node_modules/**',
    '!coverage/**',
    '!jest.config.js',
    '!**/*.test.js'
  ],
  // No JaCoCo-style COMPLEXITY counter exists for Istanbul/nyc — see
  // package.json's analyze:complexity script for an informational-only
  // complexity report instead.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};
