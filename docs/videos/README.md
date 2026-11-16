# Getting started videos

Short explainers (30–90 s) for the steps of the Getting started guide (`/portal/welcome/<step>`
and the desktop wizard). A synthetic voice reads a script, a scripted screen recording of the real
step follows it, and the captions come from the same script. Everything is made locally and
self-hosted: no script or video goes to a third party.

| Step | Video | Script | Length |
| --- | --- | --- | --- |
| How EdgeCoder works (`how`) | [how-it-works.mp4](https://edgecoder.io/assets/videos/how-it-works.mp4) ([WebM](https://edgecoder.io/assets/videos/how-it-works.webm), [captions](https://edgecoder.io/assets/videos/how-it-works.vtt)) | [scripts/how-it-works.md](scripts/how-it-works.md) | 79 s |

## Where they live

- **Scripts:** `docs/videos/scripts/<name>.md`, one per step (front matter `step:`, `name:`).
- **Files:** `src/portal/assets/videos/<name>.{mp4,webm,vtt,jpg}`, served by the portal at
  `/assets/videos/` (`src/portal/assets.ts`: byte ranges, a one-day cache, CORS for the captions)
  and copied into the server image by `npm run build` (`scripts/copy-portal-assets.mjs`).
- **The wizard:** the step's `video` in `src/common/onboarding.ts` (and its identical copy
  `desktop/src/lib/onboarding.ts`). The web guide plays it in the step's video slot. Videos are
  web only: the desktop app shows a "Watch the explainer" link that opens the step on the web.
- **This site:** pages embed the portal's files (see the guide's Getting started page).

## Voice

[Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`, GPL-3.0), run as a separate local
tool; nothing of it ships with EdgeCoder and its licence doesn't reach the audio it makes.

**Voice in use: `en_GB-cori-high`** from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)
(model files: MIT, per the repository). Trained by Bryce Beattie on about 24 hours of
[LibriVox](https://librivox.org) recordings read by Cori Samuel. LibriVox recordings are in the
**public domain**, so the voice is safe for commercial use; no attribution is required (we give
it here anyway). Model card: `en/en_GB/cori/high/MODEL_CARD` (checked 2026-11-16).

Voices checked for commercial use (dataset licence from each MODEL_CARD, 2026-11-16):

| Voice | Dataset licence | Commercial use |
| --- | --- | --- |
| en_GB-cori-high (in use) | LibriVox, public domain | yes |
| en_US-kristin-medium | LibriVox, public domain | yes |
| en_US-john-medium, en_US-norman-medium, en_US-bryce-medium | LibriVox, public domain | yes |
| en_US-ljspeech-high | LJ Speech, public domain | yes (the first cut used it) |
| en_US-joe-medium, en_US-kathleen-medium, en_US-mike-medium | OHF voice-datasets, CC0 | yes |
| en_US-hifi_tts_92-medium | NVIDIA Hi-Fi TTS, CC BY 4.0 | yes, with attribution |
| en_US-lessac-* | Blizzard 2013 licence | no (non-commercial research) |
| en_US-ryan-*, en_US-hfc_female/male, en_GB-semaine | CC BY-NC(-SA) | no |
| en_US-amy, en_GB-alan, en_GB-jenny_dioco | "see URL" (not verified) | not used |

To switch, set `voice:` in the script's front matter and put the `.onnx` and `.onnx.json` in
`$VIDEO_WORK_DIR/voices/`. Without Piper, `build.mjs` falls back to macOS `say` (Samantha; set
`SAY_VOICE`).

**Delivery:** Piper `length_scale` 1.12 (a little slower than the voice's default), 0.35 s between
sentences, 1 s between segments, and each highlight lands 0.6 s before its narration starts
(`scripts/videos/lib.mjs`). Keep sentences short: one idea each, no long lists. Spoken forms
(owner-confirmed): cSats is "see sats", `/remote` is "forward slash remote" (`PRONOUNCE`).

## Making a video

One-time setup (about 330 MB, outside the repo):

```sh
export VIDEO_WORK_DIR=~/edgecoder-videos            # default: $TMPDIR/edgecoder-videos
brew install ffmpeg
uv venv --python 3.12 "$VIDEO_WORK_DIR/piper-venv"
uv pip install --python "$VIDEO_WORK_DIR/piper-venv/bin/python" piper-tts
mkdir -p "$VIDEO_WORK_DIR/voices" && cd "$VIDEO_WORK_DIR/voices"
for ext in onnx onnx.json; do
  curl -fLO "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high.$ext"
done
npx playwright install chromium                       # if not installed yet
```

Then, from the repo:

```sh
node scripts/videos/build.mjs how                     # --say: macOS voice; --no-copy: leave the repo alone
```

`build.mjs` speaks each segment, lays them out with short pauses, writes the captions, records the
step with `scripts/videos/record.mjs` (the real portal pages on 127.0.0.1 with a made-up new
account, 1280×720, dark theme; nothing reaches a real account), and muxes MP4 (H.264/AAC), WebM
(VP9/Opus) and a JPEG poster. It waits while the machine's load is over 30 and stops below 10 GB
of free disk. Piper varies slightly from run to run, so lengths move by a few tenths of a second.

## A new step's video

1. Write `docs/videos/scripts/<name>.md` (copy `how-it-works.md`): `step:` is the wizard step id;
   each `### segment` has a `focus:` (`title`, `card:<n>`, `more`, `more:<n>`, `next`, or
   `sel:<CSS selector>` for anything else on the page, e.g. `sel:[data-action=buy]`) and the
   narration. Check facts against `src/common/onboarding.ts` and the docs it cites. Add spoken
   forms for new terms to `PRONOUNCE` in `scripts/videos/lib.mjs`.
2. Steps other than `how` have no cards: point `sel:` focuses at what the step shows (checklist
   items `[data-item=...]`, buttons `[data-action=...]`, the estimator). `record.mjs` answers every
   API call with a made-up new account (`FIXTURES`); add to it if a step needs more (for example a
   connected machine for `machines`).
3. `node scripts/videos/build.mjs <step>`, watch it, then set the step's `video` in both copies of
   the onboarding module and the table above.

Voice licences and samples: candidate voices are compared with a short sample each before a
switch; record the licence of any new voice in the table above.
