// Site automation. Thin glue over VVA_DOM / VVA_SITES / VVA_PLAYER, which hold the
// testable logic. Everything user-visible goes through the panel so a failure on a
// page we cannot inspect is still actionable.
(() => {
  "use strict";

  const DOM = globalThis.VVA_DOM;
  const SITES = globalThis.VVA_SITES;
  const PLAYER = globalThis.VVA_PLAYER;
  const CONFIG_KEY = "vva:config";
  const QUEUE_KEY = "vva:queue";

  const site = SITES.siteForLocation(location);
  if (!site) return;

  const sleep = DOM.sleep;
  let panelEl = null;
  let learnMode = null;
  let looping = false;
  let statusText = "idle";

  // ---------- panel ----------

  function panel(body) {
    if (!panelEl) {
      panelEl = document.createElement("div");
      panelEl.id = "vva-panel";
      panelEl.style.cssText = [
        "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
        "width:320px", "max-height:80vh", "overflow:auto",
        "background:#101317", "color:#e8eaed", "border:1px solid #2c3138",
        "border-radius:10px", "padding:12px", "font:13px/1.5 system-ui,sans-serif",
        "box-shadow:0 8px 28px rgba(0,0,0,.45)",
      ].join(";");
      document.documentElement.appendChild(panelEl);
    }
    statusText = body;
    panelEl.innerHTML = "";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px";
    title.innerHTML = `<span>Viral Video Agent</span><span style="opacity:.6">${site.label}</span>`;
    panelEl.appendChild(title);

    const text = document.createElement("div");
    text.style.cssText = "white-space:pre-wrap;word-break:break-word";
    text.textContent = typeof body === "string" ? body : "";
    panelEl.appendChild(text);

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px";
    for (const button of site.task === "images"
      ? [["Pause", "VVA_PAUSE"], ["Resume", "VVA_RESUME"], ["Skip", "VVA_SKIP"], ["Retry", "VVA_RETRY"]]
      : [["Fill now", "VVA_FILL"]]) {
      const b = document.createElement("button");
      b.textContent = button[0];
      b.style.cssText = "background:#1f2630;color:#e8eaed;border:1px solid #39414c;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit";
      b.onclick = () => handleAction(button[1]);
      bar.appendChild(b);
    }
    const learn = document.createElement("button");
    learn.textContent = learnMode ? `Click the ${learnMode}…` : "Teach selector";
    learn.style.cssText = "background:#2b3a55;color:#e8eaed;border:1px solid #3d5480;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit";
    learn.onclick = () => startLearning();
    bar.appendChild(learn);

    const hide = document.createElement("button");
    hide.textContent = "Hide";
    hide.style.cssText = "background:transparent;color:#9aa0a6;border:1px solid #39414c;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit";
    hide.onclick = () => panelEl.remove();
    bar.appendChild(hide);
    panelEl.appendChild(bar);
  }

  async function getConfig() {
    const data = await chrome.storage.local.get(CONFIG_KEY);
    return data[CONFIG_KEY] || {};
  }

  async function getQueue() {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    return data[QUEUE_KEY] || {};
  }

  async function setQueue(patch) {
    const queue = await getQueue();
    const next = { ...queue, ...patch };
    await chrome.storage.local.set({ [QUEUE_KEY]: next });
    return next;
  }

  async function patchArtistly(patch) {
    const queue = await getQueue();
    if (!queue.artistly) return null;
    const next = { ...queue, artistly: { ...queue.artistly, ...patch } };
    await chrome.storage.local.set({ [QUEUE_KEY]: next });
    return next.artistly;
  }

  // ---------- teaching selectors ----------

  function startLearning() {
    learnMode = "input";
    panel(`Click the box where text should be typed.
Then I will ask for the button.`);
    document.addEventListener("click", onLearnClick, true);
  }

  async function onLearnClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    const selector = DOM.buildSelector(el, document);
    const config = await getConfig();
    const selectors = { ...(config.selectors || {}) };
    selectors[site.key] = { ...(selectors[site.key] || {}), [learnMode]: selector };
    await chrome.storage.local.set({ [CONFIG_KEY]: { ...config, selectors } });
    document.removeEventListener("click", onLearnClick, true);

    if (learnMode === "input") {
      learnMode = "generate";
      panel(`Input box learned:\n${selector}\n\nNow click the Generate button.`);
      document.addEventListener("click", onLearnClick, true);
      return;
    }
    learnMode = null;
    panel(`Generate button learned:\n${selector}\n\nBoth selectors are saved in the extension options. Press Fill now to test.`);
  }

  // ---------- actions ----------

  async function handleAction(action) {
    if (action === "VVA_PAUSE") {
      await patchArtistly({ status: "paused" });
      return panel("Paused. Press Resume to continue.");
    }
    if (action === "VVA_RESUME") {
      await patchArtistly({ status: "running" });
      if (!looping) runArtistlyLoop();
      return;
    }
    if (action === "VVA_SKIP") {
      const a = (await getQueue()).artistly;
      if (!a) return;
      await patchArtistly({ cursor: a.cursor + 1 });
      return panel(`Skipped to ${a.cursor + 1}.`);
    }
    if (action === "VVA_RETRY") {
      const a = (await getQueue()).artistly;
      if (!a) return;
      await patchArtistly({ cursor: Math.max(0, a.cursor - 1), status: "running" });
      if (!looping) runArtistlyLoop();
      return;
    }
    if (action === "VVA_FILL") return site.task === "images" ? runArtistlyLoop() : fillText();
    if (action === "VVA_RUN") return runArtistlyLoop();
  }

  async function resolveSelectors() {
    const config = await getConfig();
    return SITES.selectorsFor(site, config.selectors || {});
  }

  // ---------- CloneVoice: paste the script ----------

  async function fillText() {
    const queue = await getQueue();
    const text = queue.clonevoice?.text;
    if (!text) {
      return panel("No script yet. Send /approve in Telegram, or run the pipeline from the popup.");
    }
    const sels = await resolveSelectors();
    const input = DOM.resolveInput(document, site, sels.input);
    if (!input) {
      return panel(
        `Could not find the text box on ${site.label}.\n\nPress "Teach selector" and click the box yourself - I will remember it.`
      );
    }
    DOM.setNativeValue(input, text.slice(0, 20000));
    const button = DOM.findButton(document, {
      words: sels.words.generate,
      overrideSelector: sels.buttons.generate,
      exclude: ["cancel", "delete", "close"],
    });
    const lines = [`Filled ${text.length} characters into the text box.`];
    if (site.autoClick && button) {
      button.click();
      lines.push(`Pressed "${DOM.elementLabel(button)}".`);
    } else {
      lines.push(button ? `Next: press "${DOM.elementLabel(button)}".` : "Next: press the generate button.");
    }
    lines.push("", ...site.instructions);
    panel(lines.join("\n"));
  }

  // ---------- Artistly: the image loop ----------

  function currentImageKeys() {
    const state = { seen: new Set() };
    DOM.scanImages(document, state, site.image || {});
    return state.seen;
  }

  function waitForNewImage(timeoutMs) {
    return new Promise((resolve) => {
      const before = currentImageKeys();
      const started = Date.now();
      const timer = setInterval(() => {
        const found = DOM.scanImages(document, { seen: before }, site.image || {});
        if (found.length) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve([]);
        }
      }, 1000);
    });
  }

  async function toDataUrl(src) {
    if (src.startsWith("data:")) return src;
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024) return null; // chrome.downloads chokes on huge data URLs
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  async function saveImage(item, url, variant) {
    const config = await getConfig();
    const folder = config.downloadFolder || "viral";
    const ext = url.startsWith("data:image/jpeg") ? "jpg" : "png";
    const filename = `${folder}/img_${String(item.index).padStart(3, "0")}${variant ? `_v${variant}` : ""}.${ext}`;
    if (url.startsWith("data:")) {
      chrome.runtime.sendMessage({ type: "VVA_DOWNLOAD_DATA", dataUrl: url, filename }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ type: "VVA_DOWNLOAD", url, filename }).catch(() => {});
    }
    return filename;
  }

  async function runArtistlyLoop() {
    if (looping) return;
    const queue = await getQueue();
    if (!queue.artistly?.items?.length) {
      return panel("No image queue yet.\n\nSend /approve in Telegram, or press Run in the extension popup.");
    }
    looping = true;
    const deferred = [];
    try {
      for (;;) {
        const a = (await getQueue()).artistly;
        if (!a) break;
        if (a.status === "paused") {
          panel(`Paused at ${a.cursor}/${a.items.length}.`);
          await sleep(1500);
          continue;
        }
        if (a.cursor >= a.items.length) {
          for (const item of deferred) await resolveCopy(item);
          await patchArtistly({ status: "done" });
          return panel(`Done. ${a.items.length} prompts processed.\nImages are in your Downloads folder.`);
        }

        const item = a.items[a.cursor];
        panel(`Image ${a.cursor + 1}/${a.items.length}\n${(item.prompt || "").slice(0, 180)}`);

        if (item.kind === "copy") {
          const done = await resolveCopy(item);
          if (!done) deferred.push(item);
          await patchArtistly({ cursor: a.cursor + 1, status: "running" });
          continue;
        }

        const sels = await resolveSelectors();
        const input = DOM.resolveInput(document, site, sels.input);
        const button = DOM.findButton(document, {
          words: sels.words.generate,
          overrideSelector: sels.buttons.generate,
          exclude: ["cancel", "delete", "close", "settings"],
        });

        if (!input || !button) {
          await patchArtistly({ status: "paused" });
          return panel(
            `Stopped: could not find the ${!input ? "prompt box" : "generate button"}.\n\n` +
              `Press "Teach selector" and click the ${!input ? "prompt box" : "generate button"}, then press Resume.`
          );
        }

        DOM.setNativeValue(input, item.prompt);
        await sleep(600);
        const fresh = waitForNewImage(a.generateWaitMs || 20000);
        button.click();
        const images = await fresh;

        if (!images.length) {
          await patchArtistly({ status: "paused", lastError: `no new image after ${Math.round((a.generateWaitMs || 20000) / 1000)}s` });
          return panel(
            `No new image appeared for prompt ${item.index}.\n\n` +
              "Possible causes: the site needs a setting changed, a credit prompt appeared, or the result renders in a canvas instead of an <img>.\n\n" +
              "Press Retry once you have cleared it."
          );
        }

        const limit = Math.max(1, (await getConfig()).imagesPerPrompt || 1);
        let savedUrl = null;
        for (let v = 0; v < Math.min(limit, images.length); v++) {
          const url = images[v].src.startsWith("blob:") || images[v].src.startsWith("data:")
            ? await toDataUrl(images[v].src)
            : images[v].src;
          if (!url) continue;
          await saveImage(item, url, v);
          if (v === 0) savedUrl = images[v].src;
        }
        if (savedUrl) {
          const downloaded = { ...(a.downloaded || {}), [item.index]: savedUrl };
          await patchArtistly({ downloaded });
        }

        const delay = Math.round((a.minDelayMs || 5000) + Math.random() * Math.max(0, (a.maxDelayMs || 15000) - (a.minDelayMs || 5000)));
        await patchArtistly({ cursor: a.cursor + 1, status: "running" });
        panel(`Saved image ${item.index}. Next in ${Math.round(delay / 1000)}s.\n${a.cursor + 1}/${a.items.length}`);
        await sleep(delay);
      }
    } catch (error) {
      await patchArtistly({ status: "paused", lastError: error.message });
      panel(`Loop stopped: ${error.message}\n\nPress Resume to continue.`);
    } finally {
      looping = false;
    }
  }

  /** Re-download an earlier scene's image under this scene's filename. */
  async function resolveCopy(item) {
    const a = (await getQueue()).artistly;
    const source = a?.downloaded?.[item.copyOf];
    if (!source) return false;
    const url = source.startsWith("blob:") || source.startsWith("data:") ? await toDataUrl(source) : source;
    if (!url) return false;
    await saveImage(item, url, 0);
    return true;
  }

  // ---------- VideoExpress: guidance, not blind clicking ----------

  async function showAssemblyGuide() {
    const project = (await chrome.storage.local.get("vva:project"))["vva:project"];
    const lines = ["Assemble the video here:", "", ...site.instructions.map((s, i) => `${i + 1}. ${s}`)];
    if (project?.meta?.title) {
      lines.push("", "Title and description are on the clipboard buttons below.", "", `Title: ${project.meta.title}`);
    }
    panel(lines.join("\n"));
  }

  // ---------- messages from the service worker ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.vva === "player") {
      sendResponse(PLAYER.runTool(document, message.tool, message.args || {}));
      return false;
    }
    if (message?.action === "VVA_STATUS") {
      sendResponse({ site: site.key, status: statusText, looping });
      return false;
    }
    if (message?.action === "VVA_COPY_META") {
      chrome.storage.local.get("vva:project").then((data) => {
        const meta = data["vva:project"]?.meta;
        navigator.clipboard?.writeText?.(meta ? `${meta.title}\n\n${meta.description}\n\n${meta.tags.join(", ")}` : "");
        panel(meta ? "Title, description and tags copied." : "No metadata yet.");
      });
      sendResponse({ ok: true });
      return false;
    }
    if (typeof message?.action === "string" && message.action.startsWith("VVA_")) {
      handleAction(message.action);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ---------- boot ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[QUEUE_KEY] && site.task === "images") {
      const next = changes[QUEUE_KEY].newValue?.artistly;
      if (next?.status === "running" && !looping) runArtistlyLoop();
    }
  });

  setTimeout(() => {
    if (site.task === "images") runArtistlyLoop();
    else if (site.task === "voice") fillText();
    else showAssemblyGuide();
  }, 2500);
})();
