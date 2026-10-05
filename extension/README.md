# Viral Video Agent — a Gemini + Telegram browser extension

A Manifest V3 Chrome extension that automates your faceless-doodle YouTube pipeline end to
end. Gemini is the brain (titles, script, timed subtitles, image prompts, SRT, metadata,
thumbnail), Telegram is the remote control, and content scripts fill your three tools
(CloneVoice, Artistly, VideoExpress) so you never retype anything.

```
Telegram /topics  ->  5 titles
  pick 1-9        ->  script (waits for you)
  /approve        ->  timestamps -> image prompts -> SRT + metadata
                      -> opens CloneVoice, Artistly, VideoExpress
                      -> Artistly loop renders and saves every image
```

## Load it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this `extension/` folder.
2. Open the extension **Options** (⚙): paste your **Gemini API key** (aistudio.google.com/apikey) and a
   **Telegram bot token** (@BotFather). Press **Test** / **Verify**.
3. Message your bot `/start`; it replies with your **chat id** — paste it in Options, **Save**.

Now message the bot `/topics human psychology` and watch it work, or use the popup instead.

## Important: use a *separate* bot from the Render bot

The repo's `index.js` (the Groq bot on Render) also long-polls a Telegram token. Telegram only lets
**one** program poll a token at a time — a second poller gets a 409 and messages go missing.
So give this extension its **own** bot from @BotFather (or stop the Render bot). If they collide,
the extension tells you, exactly once every 5 minutes, instead of silently dropping messages.

## The three tools are behind a login — how automation survives that

Nobody can read your CloneVoice/Artistly/VideoExpress markup from outside, so the agent **guesses**
the prompt box and the Generate button with a size-and-visibility heuristic, and then you can teach
it for real:

- The agent shows up as a slim **right-hand rail** (like the apps' own sidebars) with Run / Pause /
  Skip / Teach buttons and an expandable info card.
- The card's **Teach** button lets you click the real text box / Generate button yourself; the exact
  selectors are saved to Options and always win over the guesses.

Behaviour per site:

- **CloneVoice** – pastes the script and stops. Picking the voice is your call; then Generate and
  download the MP3.
- **Artistly** – types each prompt, presses Generate, waits for the new `<img>`, saves it to
  `Downloads/viral/`, pauses a random 5–15 s so the site doesn't see a metronome, and repeats.
  Identical consecutive prompts are reused instead of regenerated. `Pause`/`Resume`/`Skip`/`Retry`
  in the panel, or `/pause` `/resume` `/queue` in Telegram.
- **VideoExpress** – the editor puts every tool in a right-hand icon rail (Voiceover, Captions,
  Uploads, ...), so the agent *clicks that sidebar* in order: opens **Voiceover** and pastes the
  script; opens **Captions** and uploads `captions.srt` straight into the file input (or pastes it);
  opens **Uploads** and points you at `Downloads/viral/`. It reports, per step, exactly what it did
  and what is left for you.

If a render shows up in a `<canvas>` instead of an `<img>`, or a credits dialog blocks the button,
the loop pauses and tells you exactly why rather than burning a prompt.

## Gemini model gating

Google enables some models per account, so `gemini-2.5-flash` can 404 on a fresh key. The extension
does not assume one model: `/test` checks it, `/models` lists what **your** key can call, and
`/model <name>` / `/imagemodel <name>` switch. The defaults (`gemini-2.5-flash`,
`gemini-2.5-flash-image`) are what Google still serves.

## Skip the image sites entirely (optional)

`/images <n>` renders n scenes straight out of Gemini (`gemini-2.5-flash-image`) and downloads them.
Useful when Artistly is flaky or you want a fully headless run.

## Telegram commands

`/start /help` · `/topics <niche>` · `1-9` · `/approve` · `/status` · `/stop` · `/reset` ·
`/script /timestamps /prompts /srt /meta` · `/open tools|clonevoice|artistly|videoexpress` ·
`/pause /resume /queue` · `/images <n>` · `/model /imagemodel /models /test` ·
`/video play|pause|seek 30|speed 1.5|state` · `/ask <question>`

`/video` and `/ask` control any open `<video>` element (e.g. the VideoExpress preview) and answer
questions from its caption track.

## Development

Everything that matters is pure and dependency-free, so it runs under Node:

```
npm test              # 144 unit + end-to-end tests (pipeline, SRT, Telegram, DOM, worker)
npm run check:ext     # manifest references, host permissions, CSP, classic-script rules
npm run icons         # regenerate the icon PNGs
```

The service worker keeps all progress in `chrome.storage` and resumes a run that Chrome suspended,
so a 3–5 minute pipeline survives worker kills. The tests drive the **real** worker and content
scripts (with a fake `chrome` and a fake DOM), not copies of them.
