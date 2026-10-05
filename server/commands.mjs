// Which Telegram messages belong to the video pipeline (and should NOT go to the
// general Groq chat). Kept as a pure function so the routing is unit-testable.

const VIDEO_COMMANDS = new Set([
  "start", "help", "topics", "pick", "approve", "run", "continue", "stop", "reset",
  "status", "script", "timestamps", "prompts", "srt", "meta", "open", "pause",
  "resume", "queue", "images", "model", "imagemodel", "models", "test", "video", "ask",
]);

export function isVideoCommand(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // A bare number is "pick topic N" once topics exist; the router validates it.
  if (/^\d{1,2}$/.test(t)) return true;
  const cmd = (t.match(/^\/([a-zA-Z]+)/) || [])[1]?.toLowerCase();
  return Boolean(cmd) && VIDEO_COMMANDS.has(cmd);
}
