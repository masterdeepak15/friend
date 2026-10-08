#!/usr/bin/env node
// A friendly message instead of a syntax error on an old Node.js, before anything else is loaded.
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Friend needs Node.js 20 or newer, and this is ${process.versions.node}.`);
  console.error("Install a newer one from https://nodejs.org and run this again.");
  process.exit(1);
}
await import("../dist/friend.mjs");
