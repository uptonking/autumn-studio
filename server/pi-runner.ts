#!/usr/bin/env node
/**
 * Autumn Studio Pi Subprocess Runner.
 *
 * Runs as a standard Node.js process outside Paseo's in-memory eval sandbox.
 * Resolves Pi's bundled RPC entry point from `@earendil-works/pi-coding-agent`
 * and runs it with standard Node ESM resolution, filesystem access, and WASM
 * modules enabled.
 */
import { fileURLToPath } from 'node:url';

const rpcEntry: string = fileURLToPath(
  import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'),
);
await import(rpcEntry);
