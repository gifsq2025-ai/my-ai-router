// The content scripts are classic scripts (MV3 content scripts cannot use ES module
// imports), so they publish their API through a `module.exports` guard. The repo's
// package.json sets "type": "module", which would make require() treat them as ESM and
// hand back an empty namespace — so evaluate them in a fresh realm instead, the way a
// browser would.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadClassicScript(relativePath) {
  // Paths are relative to test/, not to this helper's own directory.
  const url = new URL(relativePath, new URL("../", import.meta.url));
  const code = readFileSync(url, "utf8");
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Event: globalThis.Event,
    MutationObserver: globalThis.MutationObserver,
    FileReader: globalThis.FileReader,
    CSS: globalThis.CSS,
  };
  vm.runInNewContext(code, sandbox, { filename: url.pathname });
  return module.exports;
}
