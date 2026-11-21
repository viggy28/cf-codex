#!/usr/bin/env node

import { main } from "./lib.mjs";

main().catch((error) => {
  console.error(`cf-codex: ${error.message}`);
  process.exitCode = 1;
});
