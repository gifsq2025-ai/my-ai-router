import { estimateDurationSeconds, formatSrtTime, wrapWords } from "./text.js";

/**
 * Build a valid SRT from parsed cue lines.
 *
 * End time = start of the next cue (minus a small gap) so captions never overlap.
 * For the final cue (or an absurdly long gap) fall back to a words-per-minute estimate.
 */
export function buildSrt(lines, options = {}) {
  const { defaultDuration = 4, gap = 0.05, minDuration = 1, maxDuration = 12, wordsPerMinute = 150, wrap = true } = options;
  if (!Array.isArray(lines) || lines.length === 0) return "";

  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = Number(line.seconds) || 0;
    const nextStart = i + 1 < lines.length ? Number(lines[i + 1].seconds) : null;
    let end;
    if (nextStart !== null && nextStart > start) {
      end = Math.min(nextStart - gap, start + maxDuration);
    } else {
      const est = estimateDurationSeconds(line.text, wordsPerMinute);
      end = start + Math.min(maxDuration, Math.max(minDuration, est || defaultDuration));
    }
    if (end <= start) end = start + minDuration;
    cues.push({ start, end, text: String(line.text || "").trim() });
  }

  return cues
    .filter((c) => c.text)
    .map((cue, i) => {
      const body = wrap ? wrapWords(cue.text, 40, 2).join("\n") : cue.text;
      return `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${body}\n`;
    })
    .join("\n");
}

/** Total runtime implied by a cue list (seconds). */
export function totalDurationSeconds(lines) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  const last = lines[lines.length - 1];
  return Math.round((Number(last.seconds) || 0) + estimateDurationSeconds(last.text));
}
