// DOM helpers for the site automation.
// Loaded as a classic script by the content script (MV3 content scripts cannot use
// ES module imports). The footer exposes the same API to Node for unit tests.
(function (global) {
  "use strict";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cssEscape(value) {
    const css = global.CSS;
    if (css && typeof css.escape === "function") return css.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style && (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function queryAll(doc, selector) {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  /** Biggest visible match — the script box, not the search field. */
  function bestMatch(doc, selector) {
    const matches = queryAll(doc, selector).filter(isVisible);
    if (!matches.length) return null;
    return matches.sort((a, b) => area(b) - area(a))[0];
  }

  /**
   * Set a value the way a user typing would.
   *
   * React and Vue track the native value setter, so `el.value = x` alone leaves their
   * internal state on the old value and the Generate button stays disabled. Writing
   * through the prototype setter and firing `input` is what makes it stick.
   */
  function setNativeValue(el, value) {
    if (!el) return false;
    if (el.isContentEditable) {
      el.focus?.();
      el.textContent = value;
      const InputEvent = global.InputEvent || global.Event;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    }
    const win = el.ownerDocument?.defaultView || global;
    const proto =
      typeof win.HTMLTextAreaElement !== "undefined" && el instanceof win.HTMLTextAreaElement
        ? win.HTMLTextAreaElement.prototype
        : typeof win.HTMLInputElement !== "undefined" && el instanceof win.HTMLInputElement
        ? win.HTMLInputElement.prototype
        : typeof win.HTMLSelectElement !== "undefined" && el instanceof win.HTMLSelectElement
        ? win.HTMLSelectElement.prototype
        : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
    if (descriptor && typeof descriptor.set === "function") descriptor.set.call(el, value);
    else el.value = value;
    const E = global.Event;
    el.dispatchEvent(new E("input", { bubbles: true }));
    el.dispatchEvent(new E("change", { bubbles: true }));
    return true;
  }

  const SELECTOR_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label", "placeholder"];

  /** Build a CSS selector a human could paste into the options page. */
  function buildSelector(el, doc) {
    doc = doc || (el && el.ownerDocument);
    if (!el || el.nodeType !== 1 || !doc) return "";
    if (el.id && queryAll(doc, `#${cssEscape(el.id)}`).length === 1) return `#${cssEscape(el.id)}`;
    for (const attr of SELECTOR_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (!value || /["\\]/.test(value)) continue;
      const sel = `${el.tagName.toLowerCase()}[${attr}="${value}"]`;
      if (queryAll(doc, sel).length === 1) return sel;
    }
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML" && path.length < 6) {
      if (node.id) {
        path.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(" > ");
  }

  const BUTTON_SELECTORS = ["button", '[role="button"]', 'input[type="submit"]', "a[href]"];

  function elementLabel(el) {
    return normalizeText(
      el.innerText || el.textContent || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.value || ""
    );
  }

  /**
   * Find a button by what it says.
   * Scores exact matches above prefixes above substring matches so "Generate video"
   * wins over "Generate another" when the adapter asks for "generate".
   */
  function findButton(doc, options = {}) {
    const { words = [], overrideSelector, container, exclude = [], exact = false } = options;
    if (overrideSelector) {
      const el = bestMatch(doc, overrideSelector);
      if (el) return el;
    }
    const roots = container ? [container] : [doc];
    const candidates = [];
    for (const root of roots) {
      for (const sel of BUTTON_SELECTORS) {
        for (const el of queryAll(root, sel)) if (!candidates.includes(el)) candidates.push(el);
      }
    }
    const wanted = words.map(normalizeText).filter(Boolean);
    const banned = exclude.map(normalizeText).filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (el.getAttribute?.("aria-disabled") === "true") continue;
      const label = elementLabel(el);
      if (!label) continue;
      if (banned.some((b) => label.includes(b))) continue;
      let score = 0;
      for (const w of wanted) {
        if (label === w) score = Math.max(score, 100);
        else if (label.startsWith(w)) score = Math.max(score, 60);
        else if (label.includes(w)) score = Math.max(score, 30);
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /** Locate the box to type into: user override, adapter hints, then a size heuristic. */
  function resolveInput(doc, adapter, overrideSelector) {
    if (overrideSelector) {
      const el = bestMatch(doc, overrideSelector);
      if (el) return el;
    }
    for (const sel of adapter?.input || []) {
      const el = bestMatch(doc, sel);
      if (el) return el;
    }
    return bestMatch(doc, "textarea") || bestMatch(doc, '[contenteditable="true"]') || bestMatch(doc, 'input[type="text"]');
  }

  const IGNORE_IMAGE_PATTERN = /logo|avatar|icon|favicon|sprite|badge|emoji|placeholder|1x1|blank/i;

  /**
   * One pass over the document looking for freshly rendered artwork.
   * Size plus URL filtering matters: without it the loop "downloads" the site logo.
   */
  function scanImages(doc, state, options = {}) {
    const { minWidth = 384, minHeight = 384, ignorePattern = IGNORE_IMAGE_PATTERN, allowBlob = true } = options;
    const seen = state.seen || (state.seen = new Set());
    const found = [];
    for (const img of queryAll(doc, "img")) {
      const src = img.currentSrc || img.src || img.getAttribute?.("data-src") || "";
      if (!src || seen.has(src)) continue;
      const isBlob = src.startsWith("blob:");
      const isData = src.startsWith("data:");
      if (isData && src.length < 4096) {
        seen.add(src);
        continue;
      }
      if (isBlob && !allowBlob) continue;
      if (!isBlob && !isData && !/^https?:/.test(src)) {
        seen.add(src);
        continue;
      }
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (img.complete === false) continue;
      if (w < minWidth || h < minHeight) {
        seen.add(src);
        continue;
      }
      if (!isBlob && !isData && ignorePattern.test(src)) {
        seen.add(src);
        continue;
      }
      seen.add(src);
      found.push({ src, width: w, height: h });
    }
    return found;
  }

  /** Watch for new artwork and report it. Returns a disposer. */
  function createImageWatcher(doc, options = {}) {
    const state = { seen: new Set() };
    const { onImage, intervalMs = 1500 } = options;
    scanImages(doc, state, options); // seed with what is already on the page
    const observer =
      typeof global.MutationObserver === "function"
        ? new global.MutationObserver(() => {
            for (const img of scanImages(doc, state, options)) onImage?.(img);
          })
        : null;
    if (observer) observer.observe(doc.documentElement || doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    const timer = setInterval(() => {
      for (const img of scanImages(doc, state, options)) onImage?.(img);
    }, intervalMs);
    return function stop() {
      observer?.disconnect();
      clearInterval(timer);
    };
  }

  /**
   * The three dashboards put every tool in a right-hand icon rail ("Voiceover",
   * "Captions", "Uploads", ...). Find the matching rail entry by its visible label.
   */
  function findSidebarItem(doc, label, overrideSelector) {
    if (overrideSelector) {
      const el = bestMatch(doc, overrideSelector);
      if (el) return el;
    }
    const rails = queryAll(doc, "nav, aside, [role='navigation'], [class*='sidebar' i], [class*='rail' i], [class*='tools' i]");
    const scoped = rails.length
      ? findButton({ querySelectorAll: (sel) => rails.flatMap((r) => queryAll(r, sel)) }, { words: [label], exact: true })
      : null;
    return scoped || findButton(doc, { words: [label], exact: true });
  }

  /** Locate a file input, optionally filtered by what it accepts (srt, image/*, ...). */
  function findFileInput(doc, acceptPattern) {
    const inputs = queryAll(doc, 'input[type="file"]').filter(isVisible);
    if (!inputs.length) return null;
    if (!acceptPattern) return inputs[0];
    const re = new RegExp(acceptPattern, "i");
    return inputs.find((i) => re.test(i.getAttribute("accept") || "")) || null;
  }

  /**
   * Put real files into a file input so a site's Uploads/Captions panel accepts them.
   * `files` is [{ name, type, data }] where data is a string or bytes. Chromium allows
   * assigning input.files from a DataTransfer, which is what makes automation possible.
   * Returns false on engines without File/DataTransfer so callers can fall back to hints.
   */
  function setFileInput(input, files, win) {
    if (!input || !files?.length) return false;
    win = win || input.ownerDocument?.defaultView || global;
    const FileCtor = win.File;
    const DataTransferCtor = win.DataTransfer;
    if (typeof FileCtor !== "function" || typeof DataTransferCtor !== "function") return false;
    const dt = new DataTransferCtor();
    for (const file of files) {
      const bytes = typeof file.data === "string" ? file.data : file.data;
      dt.items.add(new FileCtor([bytes], file.name, { type: file.type || "application/octet-stream" }));
    }
    try {
      input.files = dt.files;
    } catch {
      return false;
    }
    const E = win.Event || global.Event;
    input.dispatchEvent(new E("change", { bubbles: true }));
    input.dispatchEvent(new E("input", { bubbles: true }));
    return true;
  }

  const api = {
    sleep,
    normalizeText,
    cssEscape,
    isVisible,
    bestMatch,
    area,
    setNativeValue,
    buildSelector,
    findButton,
    elementLabel,
    resolveInput,
    scanImages,
    createImageWatcher,
    findSidebarItem,
    findFileInput,
    setFileInput,
    IGNORE_IMAGE_PATTERN,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.VVA_DOM = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
