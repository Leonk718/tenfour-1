/// <reference types="node" />
/**
 * Pulls @types/node ambient globals (`process`, `Buffer`, the `NodeJS` namespace, and the
 * `node:*` module declarations) into the compilation. Required because the strict tsc
 * invocation passes files explicitly (no tsconfig), which disables automatic @types
 * inclusion. The `dom` lib arrives program-wide from protocol.ts's own lib reference.
 */
export {};
