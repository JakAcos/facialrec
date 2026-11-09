/// <reference types="vite/client" />
// Every Convex module except the tests themselves, for convex-test.
export const modules = import.meta.glob([
  "./**/*.ts",
  "./**/*.js",
  "!./**/*.test.ts",
  "!./test.setup.ts",
]);
