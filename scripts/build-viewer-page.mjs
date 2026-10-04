#!/usr/bin/env node
// Generate src/viewer/page.ts from src/viewer/page.html.
//
// The page is authored as real HTML so it can be opened, linted and edited like
// a page. The runtime wants a single importable string with no asset copying in
// the build, so this escapes it into a template literal. page.ts is checked in;
// this script only has to run when the HTML changes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "viewer", "page.html");
const tsPath = join(here, "..", "src", "viewer", "page.ts");

const html = readFileSync(htmlPath, "utf8");
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const out = `// GENERATED FILE. Edit src/viewer/page.html and run:
//   node scripts/build-viewer-page.mjs
//
// The viewer is one self-contained page: no bundler, no CDN, no fonts to fetch.
// A memory store is private, so its window onto it makes no network requests
// beyond the local API it is served from.

export const PAGE = \`${escaped}\`;
`;

writeFileSync(tsPath, out);
process.stdout.write(`wrote ${tsPath} (${out.length} bytes)\n`);
