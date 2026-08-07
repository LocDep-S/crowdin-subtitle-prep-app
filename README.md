# Subtitle Source Prep

A standalone Crowdin App (left-sidebar "Organization Menu" tool, not tied to
any project or file) for one specific problem: linguists were receiving
literal ASR-style transcripts as source ".srt" files instead of real
subtitles - one giant run-on cue per breath, no line wrapping, no reading-
speed limits, filler words ("um", "uh") and stutters left in verbatim.

This app cleans a raw transcript up against Netflix's Timed Text Style Guide
or the BBC Subtitle Guidelines (or your own custom thresholds), then pushes
the result into any Crowdin project as a brand-new source file - so what
translators actually see and translate from is a properly segmented,
correctly-timed subtitle file, not a transcript.

It is deliberately a **separate Crowdin App** from the sibling
`crowdin-subtitle-timing-app` (the video+timing editor panel used inside the
Editor) - its own repo, its own OAuth Application, its own Render deployment,
its own install/approval step in Crowdin. The two apps don't share code or
runtime; see "Why separate" below.

## What it actually does

1. You drop a raw `.srt` transcript into the tool (nothing is sent to
   Crowdin yet at this point - it's pure client-side file read + a call to
   this app's own `/api/clean`).
2. Pick a preset (Netflix or BBC) or dial in custom thresholds: max
   characters per line, max lines per cue, target reading speed
   (characters/second), min/max cue duration, minimum gap between cues.
   Optionally strip disfluencies (filler words, immediate stutters).
3. The engine (`lib/subtitlePrep.js`) re-segments the transcript: it merges
   over-fragmented cues (common when a transcription tool emits one cue per
   word or per short pause), splits over-long/over-dense cues at sentence or
   clause boundaries (never mid-word), enforces min/max duration and the
   gap between cues, and reports anything it couldn't fully resolve (usually:
   dialogue that's genuinely too dense for its own real-world duration - the
   engine can't invent time the speaker didn't take) as a warning rather than
   silently forcing it.
4. You review the before/after cue list and warnings, tweak settings and
   re-run if needed, then either download the cleaned `.srt` or click
   "Upload to project" to push it straight into a chosen Crowdin project as
   a new source file (via the Storage + Add File API).

## The standards, in brief

| | Netflix Timed Text Style Guide | BBC Subtitle Guidelines |
|---|---|---|
| Max chars/line | 42 | 37 |
| Max lines | 2 | 2 |
| Reading speed | ~17 chars/sec (13 for kids' content) | ~160-180 words/min (converted here to ~15 chars/sec) |
| Min duration | 5/6 sec (~833ms) | ~1s |
| Max duration | 7s | 7s |
| Min gap between cues | ~2 frames (~83ms) | ~80ms |

Both guides also agree on breaking at grammatical boundaries (sentence/
clause, never mid-word) and on one complete idea per cue - the engine's
split logic is built around exactly that priority order (sentence-end >
comma/semicolon > any word boundary, never a mid-word cut).

## Disfluency stripping - deliberately conservative

Only removes: `um`, `uh`, `erm`, `hmm` and their variants, and *immediate*
exact repeats of the same word or short phrase (up to 3 words - "I I I want"
-> "I want", "what I what I was thinking" -> "what I was thinking"). It does
**not** touch words like "like", "you know", "so", "well" even when used as
filler, and does not attempt to detect cut-off false starts ("I wan- I
want") - both would need real linguistic judgment a heuristic can't safely
make, and the false-positive cost of getting those wrong (deleting meaning)
is higher than leaving them for a human editor. This scope was an explicit,
deliberate trade-off - see the conversation this app was built from if the
scope ever needs revisiting.

Per an explicit product decision, disfluency removal here is fully
automatic with **no visible flag/strikethrough** left in the output for a
human to double-check - if that trade-off ever needs revisiting (e.g. if a
"flag, don't delete" mode turns out to be worth the extra UI), the hook
point is `stripDisfluencies()` in `lib/subtitlePrep.js`.

## Why separate from the video/timing editor app

Three real, independent reasons, not just tidiness:

1. **Different Crowdin module type.** The editor panel app uses
   `editor-right-panel` (tied to one open file+language in the Editor).
   This tool needs `organization-menu` (a left-sidebar section, independent
   of any project) - fundamentally different UI contexts.
2. **Different point in the workflow.** Source cleanup has to happen to
   Crowdin's actual source strings, once, before/instead of a raw upload -
   not as a per-target-language overlay (see the "why not just add a button
   to the existing per-language panel" discussion this app grew out of:
   doing it per-language would only patch what one language's overlay looks
   like inside that other app's iframe, while every other language - and
   Crowdin's own translation grid, TM, and QA checks - would still be
   working from the messy transcript).
3. **Explicit choice to keep it fully independent** (own manifest, own
   OAuth Application, own deploy) rather than bolt it onto the existing
   app's installation, so the two can be deployed/updated/uninstalled
   without affecting each other.

## Setup

```
npm install
cp .env.example .env   # fill in real values, see comments in that file
npm run dev
```

Needs:
- **Upstash Redis** - can be the *same* database the sibling app uses (this
  app stores its installation record under a different key,
  `prep-installations`, so there's no collision), or a separate free-tier
  database if you'd rather keep them fully isolated.
- **A Crowdin OAuth Application** registered for *this* app specifically
  (Crowdin Enterprise: Organization Settings -> OAuth apps -> New OAuth
  app). This is separate from the sibling app's OAuth Application - each
  Crowdin App needs its own. Put the resulting client ID into
  `manifest.json`'s `authentication.clientId` and both env vars
  (`CROWDIN_CLIENT_ID`/`CROWDIN_CLIENT_SECRET`).
- **Scopes**: `project` (needed to list the org's projects for the upload
  dropdown, and to create files in the chosen one).

## Deploying

Same recipe as the sibling app: push to `main` on a Render free web service
(auto-deploys), with `PUBLIC_BASE_URL`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, `CROWDIN_CLIENT_ID`, `CROWDIN_CLIENT_SECRET` set
as environment variables. See `render.yaml` for the exact variable names.

Installing in Crowdin: Organization Settings -> Apps -> install from
manifest URL (`https://<your-render-url>/manifest.json`). Crowdin Enterprise
orgs where you aren't an admin will need an admin's approval to install,
same as the sibling app.

## Known limitations / places a real transcript might still surprise you

- **Character-count-proportional timing on splits.** When a long cue is
  split into several, each new cue's duration is divided by *character*
  count, not by anything that actually knows where the words fall in the
  audio (raw `.srt` files don't carry per-word timestamps). Usually close
  enough to be a fine starting point; genuinely uneven speech pacing within
  one original cue can still land a split's boundary slightly off from
  where the words actually change.
- **Merge pass is gap-based, not silence-based.** Cues get merged when the
  *timestamp* gap between them is small (<=300ms) and the combined result
  still fits - there's no audio analysis, so a transcription tool that
  happens to leave larger gaps between naturally-continuous phrases won't
  get merged automatically.
- **Density warnings are informational only.** If dialogue is genuinely too
  fast for the target reading speed given its real duration, the engine
  reports it and leaves it - actually fixing that means either editing the
  words (cutting content) or accepting a faster read, both editorial calls
  outside this tool's scope.
