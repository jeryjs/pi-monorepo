#!/usr/bin/env node
// Entry point for the pi patch runner. See README.md.
//   node mainrunner.js            -> apply everything once
//   node mainrunner.js help       -> full CLI reference
//   node mainrunner.js daemon start
import { main } from "./lib/cli.js";
import { errorInfo } from "./lib/util.js";

const code = await main(process.argv.slice(2)).catch((err) => {
  console.error(`\n  fatal: ${errorInfo(err).message}\n`);
  console.error(errorInfo(err).stack);
  return 1;
});

if (typeof code === "number") process.exit(code);
