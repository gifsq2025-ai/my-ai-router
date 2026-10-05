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

  // The dashboards put their tools in a right-hand icon rail, so the agent lives in one too.
  let railEl = null;
  let cardEl = null;

  function railButton(icon, label, onClick, active) {
    const b = document.createElement("button");
    b.title = label;
    b.innerHTML = `<span style="font-size:15px;line-height:1">${icon}</span><span style="font-size:10px;line-height:1.1">${label}</span>`;
    b.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;" +
      "width:52px;padding:7px 2px;background:none;border:none;cursor:pointer;font:inherit;color:#3c4043;";
    if (active) b.style.cssText += "background:#e8f0fe;border-radius:8px;";
    b.onclick = onClick;
    return b;
  }

  function ensureRail() {
    if (railEl) return railEl;
    railEl = document.createElement("div");
    railEl.id = "vva-rail";
    railEl.style.cssText = [
      "position:fixed", "top:0", "right:0", "height:100%", "z-index:2147483646",
      "width:56px", "background:#ffffff", "border-left:1px solid #dadce0",
      "display:flex", "flex-direction:column", "align-items:center", "gap:2px",
      "padding:8px 2px", "font:13px system-ui,sans-serif", "box-sizing:border-box",
    ].join(";");
    document.documentElement.appendChild(railEl);

    const head = document.createElement("div");
    head.style.cssText = "font-size:10px;color:#1a73e8;font-weight:700;margin-bottom:4px";
    head.textContent = "VVA";
    railEl.appendChild(head);

    railEl.appendChild(railButton("▶", "Run", () => handleAction(site.task === "images" ? "VVA_RUN" : "VVA_FILL")));
    if (site.task === "images") {
      railEl.appendChild(railButton("⏸", "Pause", () => handleAction("VVA_PAUSE")));
      railEl.appendChild(railButton("⏭", "Skip", () => handleAction("VVA_SKIP")));
      railEl.appendChild(railButton("↻", "Retry", () => handleAction("VVA_RETRY")));
    }
    railEl.appendChild(railButton("✎", "Teach", () => startLearning()));
    railEl.appendChild(railButton("💬", "Info", () => toggleCard(true), true));
    railEl.appendChild(railButton("✕", "Hide", () => {
      railEl?.remove();
      railEl = null;
      cardEl?.remove();
      cardEl = null;
    }));
    return railEl;
  }

  function toggleCard(open) {
    if (open === false || cardEl) {
      cardEl?.remove();
      cardEl = null;
      return;
    }
    cardEl = document.createElement("div");
    cardEl.style.cssText = [
      "position:fixed", "top:12px", "right:64px", "z-index:2147483647",
      "width:300px", "max-height:80vh", "overflow:auto",
      "background:#ffffff", "color:#202124", "border:1px solid #dadce0",
      "border-radius:10px", "padding:12px", "font:13px/1.5 system-ui,sans-serif",
      "box-shadow:0 8px 24px rgba(60,64,67,.25)",
    ].join(";");
    document.documentElement.appendChild(cardEl);
    renderCard(statusText);
  }

  function panel(body) {
    statusText = body;
    ensureRail();
    if (!cardEl) toggleCard(true); // surface the message; the user can Close or Hide
    renderCard(body);
  }

  function renderCard(body) {
    if (!cardEl) return;
    cardEl.innerHTML = "";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px";
    title.innerHTML = `<span>Viral Video Agent</span><span style="color:#5f6368">${site.label}</span>`;
    cardEl.appendChild(title);

    const text = document.createElement("div");
    text.style.cssText = "white-space:pre-wrap;word-break:break-word";
    text.textContent = typeof body === "string" ? body : "";
    cardEl.appendChild(text);

    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.cssText = "margin-top:10px;background:#f1f3f4;color:#3c4043;border:1px solid #dadce0;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit";
    close.onclick = () => toggleCard(false);
    cardEl.appendChild(close);
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
    if (action === "VVA_FILL" || action === "VVA_ASSEMBLE") {
      if (site.task === "images") return runArtistlyLoop();
      if (site.task === "assemble") return runAssembly();
      return fillText();
    }
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

  // ---------- VideoExpress: drive the sidebar, fill what we can ----------

  async function getProject() {
    return (await chrome.storage.local.get("vva:project"))["vva:project"];
  }

  async function runAssembly() {
    const steps = site.assembly || [];
    if (!steps.length) return showAssemblyGuide();
    const queue = await getQueue();
    const project = await getProject();
    const config = await getConfig();
    const report = [];
    for (const step of steps) {
      panel(`Opening ${step.label}…`);
      const button = DOM.findSidebarItem(document, step.label);
      if (!button) {
        report.push(`• ${step.label}: not found - ${step.hint}.`);
        continue;
      }
      button.click();
      await DOM.sleep(900);

      if (step.fill === "script") {
        const text = queue.clonevoice?.text || project?.script || "";
        const input = DOM.resolveInput(document, site, "");
        if (input && text) {
          DOM.setNativeValue(input, text);
          report.push(`• ${step.label}: script pasted (${text.length} chars). Pick a voice, generate.`);
        } else report.push(`• ${step.label}: opened - ${step.hint}.`);
      } else if (step.fill === "srt") {
        const srt = project?.srt || "";
        if (!srt) {
          report.push(`• ${step.label}: no captions yet - send /approve in Telegram first.`);
        } else {
          const fileInput = DOM.findFileInput(document, "srt|vtt|text|subtitle");
          const attached = fileInput && DOM.setFileInput(fileInput, [{ name: "captions.srt", type: "application/x-subrip", data: srt }]);
          if (attached) report.push(`• ${step.label}: captions.srt uploaded for you.`);
          else {
            const input = DOM.resolveInput(document, site, "");
            if (input) {
              DOM.setNativeValue(input, srt);
              report.push(`• ${step.label}: SRT pasted as text.`);
            } else report.push(`• ${step.label}: opened - ${step.hint}.`);
          }
        }
      } else if (step.fill === "images") {
        const fileInput = DOM.findFileInput(document, "image");
        report.push(
          fileInput
            ? `• ${step.label}: uploader ready - add the images from Downloads/${config.downloadFolder || "viral"}/.`
            : `• ${step.label}: ${step.hint}.`
        );
      } else {
        report.push(`• ${step.label}: opened - ${step.hint}.`);
      }
    }
    panel(
      ["Assembly pass complete:", "", ...report, "", ...site.instructions.map((line, i) => `${i + 1}. ${line}`)].join("\n")
    );
  }

  async function showAssemblyGuide() {
    const project = await getProject();
    const lines = ["Assemble the video here:", "", ...site.instructions.map((line, i) => `${i + 1}. ${line}`)];
    if (project?.meta?.title) lines.push("", `Title: ${project.meta.title}`);
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
    else runAssembly();
  }, 2500);
})();
