#!/usr/bin/env node
// Entry point: runs src/cli.ts through the tsx pinned in this package's own dependencies (never a registry fetch).
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
