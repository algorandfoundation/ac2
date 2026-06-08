module.exports = {
  // ac2-sdk uses Vitest; avoid Jest attempting to execute this package's tests.
  testPathIgnorePatterns: ['<rootDir>/tests/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
