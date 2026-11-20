#!/usr/bin/env node
// Fired by pi's launcher (installed by lib/hook.js). One node boot, no output, no window,
// never blocks pi: it runs `mainrunner.js run --quiet --trigger pi-start` and exits.
// Disable everything with PI_PATCHES_DISABLE=1.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");

if (process.env.PI_PATCHES_DISABLE === "1") process.exit(0);

const here = __dirname;

function note(message) {
  try {
    appendFileSync(join(here, "runner.log"), `${new Date().toISOString()} [error] ${message}\n`);
  } catch {
    /* logging must never break pi's startup */
  }
}

import("./lib/cli.js")
  .then((mod) => mod.main(["run", "--quiet", "--trigger", "pi-start"]))
  .then((code) => process.exit(typeof code === "number" ? code : 0))
  .catch((err) => {
    note(`trigger failed: ${(err && err.stack) || err}`);
    process.exit(1);
  });
