// Generic <video> tools. Works on any page that exposes a real video element,
// including the VideoExpress preview player.
(function (global) {
  "use strict";

  /** Longest video on the page — skips ads, previews and looping background clips. */
  function pickVideo(doc) {
    const videos = Array.from(doc.querySelectorAll("video"));
    if (!videos.length) return null;
    return videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || null;
  }

  function describe(doc) {
    const v = pickVideo(doc);
    if (!v) return "no video on this page";
    return {
      title: doc.title,
      url: global.location?.href || "",
      currentTime: Math.round(v.currentTime),
      duration: Math.round(v.duration || 0),
      paused: v.paused,
      volume: v.volume,
      speed: v.playbackRate,
      muted: v.muted,
      fullscreen: Boolean(doc.fullscreenElement),
    };
  }

  /**
   * Read the caption track.
   * `mode` must be moved off "disabled" before cues are populated — that is why a
   * first call can return nothing and a second one works.
   */
  function readCaptions(doc, options = {}) {
    const { limit = 400, enable = true } = options;
    const v = pickVideo(doc);
    if (!v) return "no video on this page";
    const tracks = Array.from(v.textTracks || []);
    if (!tracks.length) return "no captions on this video";
    const track = tracks.find((t) => t.language) || tracks[0];
    if (enable && track.mode === "disabled") track.mode = "hidden";
    const cues = Array.from(track.cues || []);
    if (!cues.length) return "captions present but not loaded yet - call again in a moment";
    return cues
      .slice(0, limit)
      .map((c) => `[${Math.floor(c.startTime)}s] ${String(c.text || "").replace(/\s+/g, " ").trim()}`)
      .filter((line) => line.length > 6)
      .join("\n");
  }

  const TOOLS = {
    play: (doc) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      v.play?.();
      return "playing";
    },
    pause: (doc) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      v.pause?.();
      return "paused";
    },
    toggle: (doc) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      if (v.paused) v.play?.();
      else v.pause?.();
      return v.paused ? "playing" : "paused";
    },
    seek: (doc, args) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      const value = Number(args.value);
      if (!Number.isFinite(value)) return "seek needs a number of seconds";
      v.currentTime = Math.max(0, Math.min(v.duration || value, value));
      return `at ${Math.round(v.currentTime)}s of ${Math.round(v.duration || 0)}s`;
    },
    skip: (doc, args) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      const delta = Number(args.value);
      if (!Number.isFinite(delta)) return "skip needs a number of seconds";
      v.currentTime = Math.max(0, (v.currentTime || 0) + delta);
      return `at ${Math.round(v.currentTime)}s`;
    },
    speed: (doc, args) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      const rate = Number(args.value);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 16) return "speed must be between 0.25 and 16";
      v.playbackRate = rate;
      return `speed ${rate}x`;
    },
    volume: (doc, args) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      let level = Number(args.value);
      if (!Number.isFinite(level)) return "volume needs a number from 0 to 1";
      if (level > 1) level = level / 100; // tolerate "volume 50"
      v.volume = Math.max(0, Math.min(1, level));
      return `volume ${Math.round(v.volume * 100)}%`;
    },
    mute: (doc) => {
      const v = pickVideo(doc);
      if (!v) return "no video on this page";
      v.muted = !v.muted;
      return v.muted ? "muted" : "unmuted";
    },
    state: (doc) => describe(doc),
    get_captions: (doc, args) => readCaptions(doc, args),
  };

  function runTool(doc, tool, args = {}) {
    const fn = TOOLS[String(tool || "").toLowerCase()];
    if (!fn) return `unknown video tool "${tool}". Available: ${Object.keys(TOOLS).join(", ")}`;
    try {
      return fn(doc, args);
    } catch (error) {
      return `video tool failed: ${error.message}`;
    }
  }

  const api = { pickVideo, describe, readCaptions, runTool, TOOLS };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.VVA_PLAYER = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
