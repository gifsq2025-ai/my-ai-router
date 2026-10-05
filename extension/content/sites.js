// Per-site automation profiles.
//
// The dashboards are login-gated SPAs, so nobody can read their markup from outside.
// Each profile is therefore: a hostname match, a list of *candidate* selectors to try,
// the words the submit button is likely to use, and a key under which the user's own
// click-to-learned selector is stored. Learned selectors always win.
(function (global) {
  "use strict";

  const SITES = {
    clonevoice: {
      key: "clonevoice",
      label: "CloneVoice",
      url: "https://app.clonevoice.ai/dashboard",
      hosts: ["app.clonevoice.ai", "clonevoice.ai"],
      task: "voice",
      input: [
        'textarea[placeholder*="text" i]',
        'textarea[placeholder*="script" i]',
        'textarea[placeholder*="type" i]',
        "textarea",
        '[contenteditable="true"]',
      ],
      buttons: {
        generate: ["generate", "synthesize", "create audio", "convert", "speak", "clone", "create"],
      },
      // Voice settings are taste, so the agent fills the script and stops.
      autoClick: false,
      instructions: [
        "Script is pasted into the text box.",
        "Pick a calm, deep voice.",
        "Press Generate, then download the MP3.",
        "VideoExpress needs that MP3 next.",
      ],
    },

    artistly: {
      key: "artistly",
      label: "Artistly",
      url: "https://app.artistly.ai/dashboard",
      hosts: ["app.artistly.ai", "artistly.ai"],
      task: "images",
      input: [
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="describe" i]',
        "textarea",
        '[contenteditable="true"]',
      ],
      buttons: {
        generate: ["generate", "create", "imagine", "draw", "run", "make"],
      },
      autoClick: true,
      image: { minWidth: 384, minHeight: 384 },
      instructions: [
        "The loop types each prompt, presses Generate and saves the result.",
        "Use Pause in this panel (or /pause in Telegram) to stop it.",
        "Images land in your Downloads/viral folder.",
      ],
    },

    videoexpress: {
      key: "videoexpress",
      label: "VideoExpress",
      url: "https://app.videoexpress.ai/",
      hosts: ["app.videoexpress.ai", "videoexpress.ai"],
      task: "assemble",
      input: ['textarea[placeholder*="description" i]', 'input[placeholder*="title" i]', "textarea"],
      buttons: { generate: ["export", "render", "create video", "generate"] },
      autoClick: false,
      instructions: [
        "Upload the MP3 from CloneVoice.",
        "Upload the images from Downloads/viral.",
        "Upload captions.srt from Telegram.",
        "Export 1080p, 16:9.",
      ],
    },
  };

  function siteForLocation(location) {
    const host = String(location?.hostname || "").toLowerCase();
    for (const site of Object.values(SITES)) {
      if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site;
    }
    return null;
  }

  /**
   * Merge the user's learned/typed selectors over the built-in candidates.
   * `overrides` comes from chrome.storage and looks like { artistly: { input: "...", generate: "..." } }.
   */
  function selectorsFor(site, overrides) {
    const mine = overrides?.[site.key] || {};
    return {
      input: mine.input || "",
      buttons: Object.fromEntries(
        Object.entries(site.buttons).map(([role, words]) => [role, mine[role] || ""])
      ),
      words: site.buttons,
    };
  }

  const api = { SITES, siteForLocation, selectorsFor };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.VVA_SITES = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
