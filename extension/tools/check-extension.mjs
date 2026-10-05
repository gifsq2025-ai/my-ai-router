// Static sanity check over the unpacked extension:
//   node tools/check-extension.mjs
// Verifies every path the manifest references exists, that the manifest declares the
// permissions the code actually uses, and that the classic content scripts contain no
// ES module syntax (which Chrome would reject at load time).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const checked = [];

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

function requireFile(path, why) {
  const full = join(root, path);
  if (!existsSync(full)) problems.push(`missing ${path} (${why})`);
  else checked.push(path);
}

if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
if (manifest.background?.type !== "module") problems.push("background must declare type: module (it uses import)");

requireFile(manifest.background.service_worker, "service worker");
requireFile(manifest.action?.default_popup, "popup");
requireFile(manifest.options_page, "options page");

for (const [size, path] of Object.entries(manifest.icons || {})) requireFile(path, `icon ${size}`);
for (const [size, path] of Object.entries(manifest.action?.default_icon || {})) requireFile(path, `action icon ${size}`);

for (const entry of manifest.content_scripts || []) {
  for (const file of entry.js) requireFile(file, "content script");
  if (!entry.matches?.length) problems.push(`content script ${entry.js[0]} has no matches`);
}

// Every host the code fetches must be in host_permissions.
const needed = ["api.telegram.org", "generativelanguage.googleapis.com", "app.clonevoice.ai", "app.artistly.ai", "app.videoexpress.ai"];
for (const host of needed) {
  if (!manifest.host_permissions?.some((pattern) => pattern.includes(host))) {
    problems.push(`host_permissions is missing ${host}`);
  }
}

// Content scripts are classic scripts: import/export would throw a SyntaxError on load.
for (const entry of manifest.content_scripts || []) {
  for (const file of entry.js) {
    const source = readFileSync(join(root, file), "utf8");
    if (/^\s*(import|export)\s/m.test(source)) problems.push(`${file} uses ES module syntax but is loaded as a classic script`);
  }
}

// The service worker and its modules must be importable ESM.
const worker = readFileSync(join(root, manifest.background.service_worker), "utf8");
for (const specifier of worker.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
  requireFile(specifier[1], "service worker import");
}

// UI pages must not contain inline scripts (blocked by the MV3 CSP).
for (const page of [manifest.action?.default_popup, manifest.options_page]) {
  const html = readFileSync(join(root, page), "utf8");
  if (/<script(?![^>]*\ssrc=)[^>]*>[^<]/.test(html)) problems.push(`${page} has an inline script, which MV3 blocks`);
  for (const src of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    requireFile(join(dirname(page), src[1]), `script tag in ${page}`);
  }
}

if (problems.length) {
  console.error("FAILED:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`OK: manifest references ${checked.length} files, all present.`);
console.log(`Permissions: ${(manifest.permissions || []).join(", ")}`);
console.log(`Hosts: ${(manifest.host_permissions || []).length} patterns`);
