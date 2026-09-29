<p align="center"><img src="public/icon-512.png" width="112" alt="Tote"></p>

<h1 align="center">Tote</h1>
<p align="center"><b>The voice in the picker's headset.</b><br>
A hands-free voice picking copilot for warehouses, and a second voice agent for the shift lead, built on the AssemblyAI Voice Agent API.</p>

<p align="center">
<a href="https://tote-voice.up.railway.app"><b>Live demo</b></a> ·
<a href="#judge-it-in-two-minutes">Judge it in 2 minutes</a> ·
<a href="#how-it-uses-assemblyai">How it uses AssemblyAI</a> ·
<a href="#measured-not-claimed">Measured, not claimed</a>
</p>

---

## Judge it in two minutes

Open **https://tote-voice.up.railway.app** in Chrome, click **Start shift** and allow the mic. You are Sam, a picker.

1. Say **"ready"**. Tote sends you to Aisle A, bay 3, level 2.
2. When Sam reaches the slot, read the check digits on the label card. **Read the wrong ones first.** Tote rejects them before anything leaves the shelf.
3. At B-07-1 the bin holds 3 mugs for an order of 4: say **"only three here"**. A replenishment task appears on the desk.
4. Walk on and a rush order lands; Tote re-routes you without being asked.
5. Say **"there's a spill in aisle F"**. The aisle closes on the map and the shift lead is alerted.
6. On the shift lead desk, click **Talk to the floor** and ask **"How's Sam doing?"**, then **"The spill is cleaned up"** and **"Tell him great pace."** Click **Back to Sam**: Tote relays the message in Sam's language.
7. Say **"end shift"**. The report pulls the call recording and re-checks every check-digit read with a second transcription pass.

## The problem

Order picking can account for as much as 55% of a warehouse's operating expense ([De Koster et al., EJOR 2007](https://www.sciencedirect.com/science/article/abs/pii/S0377221706006473)). Most of it still runs on paper lists or handheld scanners that take a hand and pull the picker's eyes off the shelf. Voice picking fixes that, but incumbent systems run on fixed grammars: every worker records a voice template first, may only say words from a short command list, and usually works in one language. That is a poor fit for seasonal, high-turnover, multilingual crews.

## What Tote does

**In Sam's headset (Tote):**
- Directs the walk and proves the location: the picker reads the slot's check digits, and a wrong slot is rejected before the pick.
- Directs the pick in plain speech: "got them", "only three here", "this one's damaged".
- Handles the floor: shorts raise replenishment, damage goes on QA hold, a spill closes the aisle and re-sequences the picks, a rush order re-routes the picker mid-walk.
- Six headset languages (English, Spanish, German, French, Italian, Portuguese), with no voice training.

**At the shift lead's desk (Tote Desk):** a second, independent voice agent for Dana.
- "How's Sam doing?" is answered from the live floor.
- "Tell him great pace" is relayed into Sam's headset, in Sam's language.
- "The spill in aisle F is cleaned up" reopens the aisle and Tote routes Sam back through it.
- "Drop the rush order" and answers to Sam's pages act on the picker's session.

**After the shift:** a report with supervisor notes, the stereo session recording, and **voice analytics**: Universal-3 Pro re-transcribes the recording channel by channel, re-finds every check-digit read, and adds talk time, Sam's sentiment across the shift and key phrases.

## How it uses AssemblyAI

Four products, four jobs:

| Job | AssemblyAI | How Tote uses it |
| - | - | - |
| 🎧 The headset and the desk | **Voice Agent API** | Two concurrent sessions (picker and shift lead) over WebSockets with single-use browser tokens. The desk's tools act on the picker's session. |
| 👂 The ears | Universal-3 Pro streaming, inside the agent | `keyterms` and a `transcription_prompt` for SKUs and floor vocabulary; `language_codes` steered to the picker's language; `voice_focus: far-field` for a noisy floor; pinned `min_silence`/`max_silence`. |
| 📼 The black box | **Sessions API** | The stereo recording (picker left, agent right) and conversation timeline behind every shift report. |
| 🔍 The auditor | **Universal-3 Pro pre-recorded** | A multichannel pass with `sentiment_analysis` and `auto_highlights` on the recording: a second, independent transcript that re-checks every check-digit read. |

Voice Agent API features in use, and where:

| Feature | In Tote | Code |
| - | - | - |
| Client-side tools, revealed per step with `session.update` | Each phase (briefing → travel → pick → paused → complete) exposes only its tools. `confirm_pick` doesn't exist until the slot is verified. | `src/sim/shift.ts` |
| Value-free tools | The model picks the intent; `parse.ts` reads digits and counts from the transcript (tolerant of homophones like "set six" for *sept six*). The LLM never produces a check digit. | `src/sim/parse.ts` |
| Guardrail on untooled replies | If a reply to "seven six" arrives without a tool call, the state machine runs the check and Tote corrects the instruction. | `VoiceAgent` `untooled` → `Shift.guard` |
| `reply.create` + `conversation.message` | Rush re-routes, relayed desk messages and "aisle clear" notices are spoken without a user turn. | `Shift.injectRush`, `Shift.broadcast` |
| `execution_mode: "hold"` | `call_supervisor` holds the agent silent until the lead answers. | `T.call_supervisor` |
| Semantic barge-in | Playback is flushed only on `reply.done` with `interrupted`. | `src/App.tsx` |
| Word-timed agent transcript | `transcript.agent.delta` `start_ms` drives karaoke captions in sync with the audio. | `src/voice/agent.ts` |

## Measured, not claimed

Every number below comes from full shifts played against the live API by `scripts/drive.ts`: synthesized pickers read every line of the seeded tote, including one deliberately misread check digit (`WRONG=1`). "Noisy floor" mixes a warehouse hum and forklift reverse beeps under the picker at about -24 dBFS, with `voice_focus: far-field`.

| Run | Lines right | Misread check digit | Guard corrections | Speech end → voice (p50 / p95) | First verified pick |
| - | - | - | - | - | - |
| English | 8/8 | rejected | 0 | 1.72 s / 1.92 s | 10.3 s |
| Spanish | 8/8 | rejected | 0 | 1.72 s / 2.13 s | 29.5 s |
| German | 8/8 | rejected | 1 | 1.70 s / 1.96 s | 10.7 s |
| French | 8/8 | rejected | 1 | 1.77 s / 2.06 s | 11.8 s |
| Italian | 8/8 | rejected | 0 | 1.74 s / 2.05 s | 7 s |
| Portuguese | 8/8 | not accepted, re-asked | 3 | 1.70 s / 1.96 s | 10.7 s |
| English, noisy floor | 8/8 | rejected | 0 | 1.71 s / 1.93 s | 9.8 s |
| Spanish, noisy floor | 8/8 | rejected | 0 | 1.74 s / 1.98 s | 12.1 s |

**8 runs, 64/64 lines right; no run verified a slot on the misread digits.** Picker voices: ElevenLabs lines for English and Portuguese, macOS system voices for Spanish, German, French and Italian. A misread is "rejected" when the digits don't match the slot, and "re-asked" when only one digit was recognised; either way the slot is not verified.

- **Latency:** speech end → Tote's first audio went from **3.96 s** (default adaptive turn-taking) to **1.6 s**, after measuring that the adaptive end-of-turn window had stretched to about 3 s because pickers go quiet while walking.
- **Second pass:** in the demo shift, **9/9** check-digit reads the live agent acted on were re-found in the picker channel by the post-shift Universal-3 Pro transcription.
- **Cost:** at the $4.50 per session-hour list price, the 3.2-minute, 8-line demo tote costs about **$0.24**, roughly **$0.03 per picked line**, plus about $0.23 per recorded hour for the analysis pass.

Reproduce a run:

```bash
TOTE_LANG=de WRONG=1 node scripts/drive.ts          # German shift
NOISE=1 WRONG=1 node scripts/drive.ts               # English on a noisy floor
DESK=1 BREAK=1 WRONG=1 TAPE=demo node scripts/drive.ts   # the demo: spill + Tote Desk
node video/scorecard.mjs                            # rebuild the table
```

## Honest limits

- The warehouse is a seeded simulation; there is no WMS connector yet.
- Voices in the recorded demo and the scorecard are synthesized (ElevenLabs lines and macOS voices); the live app takes any microphone.
- 1.6 s to voice is slower than a legacy system's beep, so Tote plays an instant "heard you" tick when the picker stops talking.
- Our AssemblyAI account has no LLM Gateway access, so shift notes are built from the pick log by rules; the code calls the Gateway first and falls back.
- Session pricing means sessions should cover active picking, not whole shifts.
- The demo floor has one picker; Tote Desk is built to answer for several.

## Run it

Needs Node 22.18+ and an AssemblyAI API key.

```bash
cp .env.example .env        # add ASSEMBLYAI_API_KEY
npm install
npm run build && npm start  # http://localhost:8787
```

For development, run `npm run server` (the API on :8787) and `npm run dev` (Vite on :5178, which proxies `/api`).

`video/` holds the demo-video pipeline: `drive.ts` records a tape of a live session, `render.mjs` replays it through the real app frame by frame on a virtual clock, `mix.mjs` rebuilds the audio, and `assemble.mjs` cuts the final video.

## Built with

AssemblyAI Voice Agent API · Universal-3 Pro · Sessions API · React + Vite · Node 24 (no server dependencies) · Railway. The Tote icon and Sam character were made with Higgsfield.

MIT licensed.
