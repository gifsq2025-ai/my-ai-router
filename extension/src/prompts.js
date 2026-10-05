// Every prompt the agent sends to Gemini lives here, as a pure function.
// Kept separate from the client so prompts can be reviewed/edited without touching plumbing.

const STYLE_GUARD =
  "no photorealism, no 3D render, no gradients, no drop shadows, no textures, no realistic faces, no anime style, flat black line art only";

const BASE_SCENE =
  "simple stick figure with a large circular head, dot eyes, thick eyebrow line, thick black outline doodle illustration, single solid background color";

export const BACKGROUNDS = [
  "ancient or historical scene = solid tan background",
  "danger or threat = solid white background with a single red accent",
  "happy or success = solid white background with yellow accent",
  "night or sleep = solid orange background",
  "science or brain = solid blue background",
  "nature or calm = solid green background",
];

export function topicsPrompt(niche, count = 5) {
  return `You are a viral YouTube strategist for a faceless doodle-style explainer channel.
Niche: "${niche}".

Write exactly ${count} video titles.

Rules:
- Under 70 characters each.
- Combine curiosity with a clear benefit to the viewer.
- Use the word "you" or "your" when it fits naturally.
- No clickbait lies, no ALL CAPS, no emojis, no numbering inside the title.

Reply with ONLY a numbered list:
1. Title one
2. Title two`;
}

export function scriptPrompt(topic, { minWords = 1800, maxWords = 2200, tone = "calm" } = {}) {
  return `Write a YouTube narration script about: "${topic}".

Length: ${minWords}-${maxWords} words.
Voice: ${tone}, second person. Address the viewer as "you". Never use "I", "we", "us" or "in this video".
Structure: a hook in the first three sentences, then 5 to 7 sections that each make one point, then a closing line that echoes the opening line.
Style: short sentences. Simple everyday words. No headings, no bullet points, no stage directions, no "[music]" or "[pause]" markers.

Output ONLY the narration text.`;
}

export function timestampsPrompt(script, { wordsPerMinute = 150, secondsPerCue = 6 } = {}) {
  const body = String(script || "").slice(0, 18000);
  return `Split this narration into timed subtitle cues.

Rules:
- Assume a speaking rate of ${wordsPerMinute} words per minute.
- Each cue should be about ${secondsPerCue} seconds of speech (roughly 12-20 words).
- Timestamps must start at [00:00] and always increase.
- Do not rewrite, reorder, add or remove any words from the narration.
- Do not add headings or commentary.

Reply with ONLY lines in this exact format:
[00:00] first few words of the script
[00:06] next few words

Narration:
"""
${body}
"""`;
}

export function imagePromptsPrompt(cueLines, { reuseWindow = 3 } = {}) {
  const block = cueLines
    .map((l) => `[${pad(l.seconds)}] ${l.text}`)
    .join("\n");
  return `For each subtitle cue below, write ONE image prompt for a doodle-style illustration.

Base style, include it in every prompt:
${BASE_SCENE}.

Background colour rules:
${BACKGROUNDS.map((b) => `- ${b}`).join("\n")}

Consistency: if ${reuseWindow} consecutive cues describe the same moment or the same scene, give them the SAME prompt so the image can be reused.

Every prompt MUST end with exactly:
, ${STYLE_GUARD}

Reply with ONLY lines in this exact format, one per cue, same order:
[00:00] | prompt text here
[00:06] | prompt text here

Cues:
${block}`;
}

export function metadataPrompt(topic, script) {
  const summary = String(script || "").slice(0, 4000);
  return `Create YouTube metadata for a video titled "${topic}".

Reply using EXACTLY these section labels:

TITLE: <under 70 characters, curiosity plus benefit>
DESCRIPTION:
<2 line hook that makes someone click>
<150 word summary of the video>
<3 hashtags on their own line>
TAGS: <30 comma separated tags, no hashtags, no quotes>

Video script:
"""
${summary}
"""`;
}

export function thumbnailPrompt(topic) {
  return `Write ONE text-to-image prompt for a 1280x720 YouTube thumbnail about "${topic}".

Requirements: doodle illustration style, very high contrast, one single focal subject, empty space on one third of the frame for large text, no small details.
End the prompt with exactly: , ${STYLE_GUARD}

Reply with ONLY the prompt, no labels, no quotes.`;
}

export function reusePlanPrompt(prompts) {
  const block = prompts.map((p, i) => `${i + 1}. ${p.prompt}`).join("\n");
  return `These are image prompts in video order. Many are duplicates or near duplicates.

Return ONLY a JSON array of objects {"keep": <1-based index to actually generate>, "reuse": [<1-based indexes that can use that same image>]}.
Cover every index exactly once. No commentary, no markdown fences.

Prompts:
${block}`;
}

function pad(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const h = Math.floor(m / 60);
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m % 60)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

/** System-ish preamble used when asking Gemini about a transcript. */
export function transcriptQuestionPrompt(question, captions) {
  return `Answer using ONLY the transcript below. If the answer is not in it, say so in one sentence.

Transcript:
"""
${String(captions || "").slice(0, 20000)}
"""

Question: ${question}`;
}
