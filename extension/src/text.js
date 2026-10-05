// Pure text helpers shared by the pipeline. No Chrome APIs, no fetch — fully unit testable.

const MARKDOWN_FENCE = /^\s*```[a-zA-Z]*\s*$/;

/** Strip ``` fences and leading markdown emphasis that models like to add. */
export function cleanModelText(raw) {
  if (typeof raw !== "string") return "";
  const lines = raw.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && (MARKDOWN_FENCE.test(lines[start]) || lines[start].trim() === "")) start++;
  while (end > start && (MARKDOWN_FENCE.test(lines[end - 1]) || lines[end - 1].trim() === "")) end--;
  return lines
    .slice(start, end)
    .map((l) => l.replace(/\*\*/g, "").replace(/^[ \t]*[#>\-*]+[ \t]+/, ""))
    .join("\n")
    .trim();
}

/** "1. Title" / "1) Title" / "1 - Title" -> ["Title", ...] */
export function parseNumberedList(raw) {
  return cleanModelText(raw)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d{1,2})\s*[.)\-–—:]\s*(.+?)\s*$/))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[2].replace(/^["'“”]+|["'“”]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * Accepts "90", "1:30", "01:02:03", "01:02:03.500". Returns seconds (float) or null.
 */
export function parseClockstamp(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/);
  if (!m) {
    const plain = value.trim().match(/^(\d{1,6})(?:\.\d+)?\s*s?$/);
    return plain ? Number(plain[1]) : null;
  }
  const [, a, b, c, frac] = m;
  const seconds = c !== undefined ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
  return seconds + (frac ? Number(frac.padEnd(3, "0")) / 1000 : 0);
}

/** seconds -> "HH:MM:SS,mmm" (SRT format) */
export function formatSrtTime(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}

/** seconds -> "[MM:SS]" or "[HH:MM:SS]" when over an hour. */
export function formatClockstamp(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

const TIMESTAMP_LINE = /^\s*[\[*_]*\[(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?)\][\]*_]*\s*[:\-–—]?\s*(.*)$/;

/**
 * Parse Gemini output into [{ seconds, text }].
 * Tolerates "[00:00] text", "00:00 - text", "**[00:00]** text" and blank/filler lines.
 * Timestamps are forced to be non-decreasing so the SRT can never go backwards.
 */
export function parseTimestampLines(raw) {
  const out = [];
  let last = 0;
  for (const rawLine of cleanModelText(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(TIMESTAMP_LINE) || line.match(/^\s*[\[*_]*(\d{1,2}:\d{1,2}(?::\d{1,2})?)[\]*_]*\s*[:\-–—]\s+(.+)$/);
    if (!m) {
      // Continuation of the previous cue — merge instead of dropping narration.
      if (out.length) out[out.length - 1].text = `${out[out.length - 1].text} ${line}`.trim();
      continue;
    }
    const seconds = parseClockstamp(m[1]);
    const text = (m[2] || "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (seconds === null || !text) continue;
    const t = Math.max(seconds, last);
    last = t;
    out.push({ seconds: t, text });
  }
  return out;
}

/** "[00:00] | prompt text" or "[00:00] prompt text" -> [{ seconds, prompt }] */
export function parsePromptLines(raw) {
  const out = [];
  for (const rawLine of cleanModelText(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(TIMESTAMP_LINE);
    if (m) {
      const seconds = parseClockstamp(m[1]);
      const prompt = (m[2] || "").replace(/^\s*\|+\s*/, "").trim();
      if (seconds !== null && prompt) out.push({ seconds, prompt });
      continue;
    }
    const m2 = line.match(/^\s*(\d{1,3})\s*[.):\-–—]\s*(.+)$/);
    if (m2) {
      const prompt = m2[2].replace(/^\s*\|+\s*/, "").trim();
      if (prompt) out.push({ seconds: null, prompt });
    }
  }
  return out;
}

/** Rough spoken duration for a clip of narration. */
export function estimateDurationSeconds(text, wordsPerMinute = 150) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return (words / Math.max(1, wordsPerMinute)) * 60;
}

/**
 * Telegram hard limit is 4096 UTF-16 code units. Split safely:
 * never break a surrogate pair, prefer a paragraph/line boundary, then a space.
 */
export function chunkText(text, limit = 3900) {
  const str = String(text ?? "");
  if (str.length <= limit) return str.length ? [str] : [];
  const chunks = [];
  let rest = str;
  while (rest.length > limit) {
    let cut = -1;
    const window = rest.slice(0, limit + 1);
    const nl = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (nl > limit * 0.5) cut = nl + 1;
    else {
      const sp = window.lastIndexOf(" ");
      if (sp > limit * 0.5) cut = sp + 1;
    }
    if (cut <= 0) cut = limit;
    // Cutting just past a space/newline would overshoot by one, so clamp back.
    cut = Math.min(cut, limit);
    // Never split a UTF-16 surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // No trimming here: chunkText must be lossless, so join(chunks) === text.
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const SECTION_RE = /^(TITLE|DESCRIPTION|TAGS|HASHTAGS|THUMBNAIL|THUMBNAIL PROMPT)\s*:\s*(.*)$/i;

/** Parse the "TITLE: ...\nDESCRIPTION:\n...\nTAGS: a, b" metadata block. */
export function parseMetadata(raw) {
  const text = cleanModelText(raw);
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(SECTION_RE);
    if (m) {
      current = m[1].toUpperCase().replace(/\s+/g, " ");
      sections[current] = m[2].trim();
    } else if (current) {
      sections[current] = `${sections[current]}\n${line}`.trim();
    }
  }
  // YouTube tags are bare words; hashtags keep their "#" so they can be pasted into a description.
  const splitTags = (v) =>
    String(v || "")
      .split(/[,\n]+/)
      .map((s) => s.replace(/^#+\s*/, "").trim())
      .filter(Boolean);
  const splitHashtags = (v) =>
    String(v || "")
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("#") ? s : `#${s.replace(/^@/, "")}`));
  const description = sections.DESCRIPTION || "";
  return {
    title: (sections.TITLE || "").split("\n")[0].slice(0, 100),
    description,
    tags: splitTags(sections.TAGS).slice(0, 40),
    hashtags: splitHashtags(sections.HASHTAGS).length
      ? splitHashtags(sections.HASHTAGS).slice(0, 5)
      : (description.match(/#\w+/g) || []).slice(0, 5),
    thumbnail: sections.THUMBNAIL || sections["THUMBNAIL PROMPT"] || "",
    raw: text,
  };
}

/** Greedy word wrap used for readable subtitles. */
export function wrapWords(text, maxChars = 40, maxLines = 2) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(" ").split(/\s+/).filter(Boolean).length;
  const dropped = words.length - consumed;
  if (dropped > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} …`;
  return lines;
}

export function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}
