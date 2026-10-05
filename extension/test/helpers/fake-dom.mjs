// Just enough DOM to run the content-script logic under node:test.
// Supports the selector forms the automation actually uses: tag, #id,
// [attr], [attr="v"], [attr*="v" i], [attr^="v"], plus comma lists.

function matchesCompound(el, compound) {
  let rest = compound.trim();
  const attributeTests = [];
  let nthOfType = null;

  rest = rest.replace(/:nth-of-type\((\d+)\)/g, (_all, n) => {
    nthOfType = Number(n);
    return "";
  });

  // Pull off [attr...] parts.
  rest = rest.replace(/\[([^\]]+)\]/g, (_all, inner) => {
    const m = inner.match(/^([\w-]+)\s*(\*?=|\^=|\$=)?\s*("?)([^"]*?)\3\s*(i)?$/);
    if (!m) return "";
    const [, attr, op, , rawValue, flag] = m;
    attributeTests.push({ attr, op: op || null, value: rawValue, insensitive: Boolean(flag) });
    return "";
  });

  if (rest.startsWith("#")) {
    if (el.id !== rest.slice(1)) return false;
    rest = "";
  }
  if (rest && rest !== "*") {
    if (el.tagName.toLowerCase() !== rest.toLowerCase()) return false;
  }

  for (const test of attributeTests) {
    const actual = el.getAttribute(test.attr);
    if (actual === null) return false;
    if (!test.op) continue;
    const a = test.insensitive ? actual.toLowerCase() : actual;
    const b = test.insensitive ? test.value.toLowerCase() : test.value;
    if (test.op === "=" && a !== b) return false;
    if (test.op === "*=" && !a.includes(b)) return false;
    if (test.op === "^=" && !a.startsWith(b)) return false;
    if (test.op === "$=" && !a.endsWith(b)) return false;
  }

  if (nthOfType !== null) {
    const parent = el.parentElement;
    if (!parent) return false;
    const sameTag = parent.children.filter((child) => child.tagName === el.tagName);
    if (sameTag.indexOf(el) + 1 !== nthOfType) return false;
  }
  return true;
}

// Split "body > div > textarea:nth-of-type(2)" into combinator/compound steps.
function splitChain(selector) {
  const steps = [];
  let current = "";
  let comb = " ";
  const text = selector.trim();
  for (const ch of text) {
    if (ch === ">") {
      if (current.trim()) steps.push({ comb, compound: current.trim() });
      comb = ">";
      current = "";
    } else if (/\s/.test(ch)) {
      if (current.trim()) {
        steps.push({ comb, compound: current.trim() });
        comb = " ";
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) steps.push({ comb, compound: current.trim() });
  return steps;
}

function matchesChain(el, steps) {
  if (!steps.length) return false;
  if (!matchesCompound(el, steps[steps.length - 1].compound)) return false;
  let node = el;
  for (let i = steps.length - 1; i > 0; i--) {
    const { comb } = steps[i];
    const wanted = steps[i - 1].compound;
    node = node.parentElement;
    if (comb === ">") {
      if (!node || !matchesCompound(node, wanted)) return false;
    } else {
      let found = false;
      while (node) {
        if (matchesCompound(node, wanted)) {
          found = true;
          break;
        }
        node = node.parentElement;
      }
      if (!found) return false;
    }
  }
  return true;
}

function matches(el, selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => matchesChain(el, splitChain(part)));
}

export function element(tag, options = {}) {
  const attrs = { ...(options.attributes || {}) };
  if (options.id) attrs.id = options.id;
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: options.id || "",
    children: [],
    parentElement: null,
    ownerDocument: null,
    textContent: options.text ?? "",
    innerText: options.text ?? "",
    value: options.value ?? "",
    isContentEditable: Boolean(options.contentEditable),
    disabled: Boolean(options.disabled),
    complete: options.complete ?? true,
    src: options.src ?? "",
    currentSrc: options.currentSrc ?? "",
    naturalWidth: options.naturalWidth ?? 0,
    naturalHeight: options.naturalHeight ?? 0,
    width: options.width ?? 0,
    height: options.height ?? 0,
    _width: options.rectWidth ?? 100,
    _height: options.rectHeight ?? 40,
    events: [],
    attributes: attrs,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === "id") el.id = String(value);
    },
    getBoundingClientRect() {
      return { width: el._width, height: el._height, top: 0, left: 0 };
    },
    dispatchEvent(event) {
      el.events.push(event);
      return true;
    },
    click() {
      el.events.push({ type: "click" });
      el.clicks = (el.clicks || 0) + 1;
    },
    focus() {
      el.focused = true;
    },
    querySelectorAll(selector) {
      return collect(el).filter((child) => matches(child, selector));
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    },
    appendChild(child) {
      child.parentElement = el;
      child.ownerDocument = el.ownerDocument;
      el.children.push(child);
      return child;
    },
  };
  return el;
}

function collect(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function document(options = {}) {
  const docElement = element("html");
  const body = element("body", { rectWidth: 1200, rectHeight: 800 });
  docElement.appendChild(body);
  const doc = {
    nodeType: 9,
    title: options.title || "Test page",
    documentElement: docElement,
    body,
    defaultView: {
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    },
    fullscreenElement: null,
    querySelectorAll(selector) {
      return collect(docElement).filter((el) => matches(el, selector));
    },
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] || null;
    },
    createElement(tag) {
      const el = element(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  for (const el of collect(docElement)) el.ownerDocument = doc;
  return doc;
}

/** Build a video element with the handful of properties the player tools touch. */
export function fakeVideo(options = {}) {
  return {
    duration: options.duration ?? 600,
    currentTime: options.currentTime ?? 0,
    paused: options.paused ?? true,
    volume: options.volume ?? 1,
    muted: false,
    playbackRate: 1,
    playCalls: 0,
    pauseCalls: 0,
    textTracks: options.textTracks ?? [],
    play() {
      this.playCalls++;
      this.paused = false;
    },
    pause() {
      this.pauseCalls++;
      this.paused = true;
    },
  };
}
