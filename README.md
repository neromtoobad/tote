<p align="center"><img src="public/icon-512.png" width="112" alt="Tote"></p>

<h1 align="center">Tote</h1>
<p align="center"><b>A hands-free voice picking copilot for warehouses, built on the AssemblyAI Voice Agent API.</b><br>
Pickers keep both hands on the product and their eyes on the shelf. Tote talks them through every pick, checks they are at the right slot, logs shorts and damage, and re-routes them when a rush order lands.</p>

<p align="center">
<a href="https://tote-voice.up.railway.app"><b>Live demo</b></a> ·
<a href="#how-it-uses-assemblyai">How it uses AssemblyAI</a> ·
<a href="#run-it">Run it</a>
</p>

---

## The problem

Order picking is the most labour-intensive job in a fulfilment centre, and most of it still runs on paper lists or handheld scanners that tie up a hand and pull the picker's eyes off the shelf. Voice picking fixes that, which is why it became a category of its own. But the incumbent systems are built on fixed grammars: every worker trains a voice template before their first shift, they may only say words from a short command list, and they mostly work in one language.

That is a poor fit for a workforce with high turnover, seasonal surges and many first languages.

## What Tote does

Tote is the voice in the picker's headset.

1. **Directs the walk.** "Aisle B, bay 7, level 1." The floor map shows the route.
2. **Proves the location.** The picker reads back the two check digits printed on the slot label. A wrong slot is rejected before anything leaves the shelf.
3. **Directs the pick.** "Pick 4, sage ceramic mug." The picker answers in plain speech: "got them", "only three here", "this one's damaged".
4. **Handles the floor.** A short pick raises a replenishment task. Damage puts the slot on QA hold. A blocked aisle gets skipped and flagged to the lead. An over-pick is caught ("that's 2 too many").
5. **Adapts mid-shift.** A rush order drops, and Tote speaks up unprompted to re-route the picker. The shift lead can type a message and Tote relays it in the picker's language. If the picker asks for help, Tote pages the lead and goes quiet until the lead answers.
6. **Closes the loop.** At the end of the shift Tote pulls the session recording and the conversation timeline from AssemblyAI, and writes supervisor notes through the LLM Gateway. Every pick is backed by the words spoken at the slot.

No voice training, no command vocabulary, and six headset languages out of the box.

## How it uses AssemblyAI

| Capability | Where it shows up in Tote | Code |
| - | - | - |
| **Voice Agent API** over WebSocket, with browser temporary tokens | One socket carries speech-to-text, the LLM, turn-taking and the voice. The API key never reaches the browser; the server mints a single-use token for each shift. | [`src/voice/agent.ts`](src/voice/agent.ts), [`server/index.ts`](server/index.ts) |
| **Client-side tools with JSON Schema** | 10 tools (`confirm_location`, `confirm_pick`, `report_exception`, …) run against the shift state in the browser. | [`src/sim/shift.ts`](src/sim/shift.ts) |
| **Parameter hints** (`pattern`, `enum`, `examples`) | Check digits carry `pattern: " *[0-9] *[0-9] *"`, so the agent waits for both digits instead of cutting in after "four…". Exceptions are an `enum`, so the model can't invent one. | `T.confirm_location`, `T.report_exception` |
| **Progressive tool reveal** via `session.update` | Each phase (briefing → travel → pick → paused → complete) pushes its own system prompt and tool list. `confirm_pick` doesn't exist until the location is verified, so the agent cannot log a pick at the wrong slot. | `PHASE_TOOLS`, `Shift.prompt()` |
| **Tool-result timing** | Results are sent only when `reply.done` is the latest event, and the next phase's `session.update` goes out just before them. | `VoiceAgent.flushTools()` |
| **`reply.create` + `conversation.message`** | The rush-order re-route and the shift lead's broadcasts are spoken proactively, queued until the floor is free. | `Shift.injectRush()`, `Shift.broadcast()` |
| **`execution_mode: "hold"`** | `call_supervisor` holds the agent silent until the lead answers from the desk, with a `reply.create` status line while it waits. | `T.call_supervisor`, `VoiceAgent.resolveHold()` |
| **Semantic barge-in** | Local playback is flushed only when the server reports `reply.done` with status `interrupted`. Back-channels like "uh-huh" don't cut the agent off. | `App.tsx`, `audio.ts` |
| **`keyterms` + `transcription_prompt`** | SKU names and floor vocabulary ("short", "damaged", "skip") are biased in. | `Shift.initialConfig()` |
| **`voice_focus: "far-field"`** | The "Noisy floor" toggle switches server-side voice isolation for a loud warehouse. | header toggle |
| **Multilingual voices** | English (`alba`), Spanish (`lola`), German (`juergen`), French (`estelle`), Italian (`giovanni`), Portuguese (`rafael`), with `language_codes` for recognition. | `LANGS` |
| **Word-level agent transcript** (`transcript.agent.delta`) | Live headset captions, marked when interrupted. | `Headset` panel |
| **Sessions API** (recordings + timeline) | The end-of-shift report embeds the call recording and uses the timeline as the audit trail. | `/api/report` |
| **LLM Gateway** | Writes the supervisor notes from the pick log plus the timeline (`claude-sonnet-5`). | `/api/report` |

The UI shows the mechanics live: the **tool list** in the headset panel lights up per phase, the **Voice Agent API panel** logs every WebSocket frame, and the **latency tile** measures end-of-speech to first agent audio.

## The shift state machine

| Phase | The agent's job | Tools it can call |
| - | - | - |
| `briefing` | Wait for "ready" | `start_batch`, `shift_status`, `call_supervisor` |
| `travel` | Give the location, verify the check digits | `confirm_location`, `skip_location`, `shift_status`, `pause_shift`, `call_supervisor` |
| `pick` | Give quantity + item, record the result | `confirm_pick`, `report_exception`, `shift_status`, `pause_shift`, `call_supervisor` |
| `paused` | Stay quiet until "I'm back" | `resume_shift`, `shift_status`, `call_supervisor` |
| `complete` | Send the tote to pack | `end_shift`, `shift_status` |

Every tool result carries a `say` field: the exact, short instruction the agent should speak. The system prompt forbids stating any location, quantity or check digit that didn't come from a tool result.

## Try the demo

Open the live demo in Chrome or Edge, click **Start shift**, and allow the microphone. You're Sam, a picker on tote T-1042.

- Say **"ready"**.
- When Sam reaches the slot, read the **check digits** on the label card. Try a wrong number first.
- Look at the bin. B-07-1 has only 3 mugs for an order of 4, so say "only three here". D-06-2's yoga mat is crushed.
- Mid-shift, a rush order re-routes you. Ask "how am I doing?", say "I need a break", or ask for your supervisor, then answer as Dana on the desk.
- Say "end shift" at pack station 3 to get the shift report with the recording.

## Run it

Needs Node 22.18+ and an AssemblyAI API key.

```bash
cp .env.example .env        # add ASSEMBLYAI_API_KEY
npm install
npm run build && npm start  # http://localhost:8787
```

For development, run `npm run server` (the API on :8787) and `npm run dev` (Vite on :5178, which proxies `/api`).

### Rehearse a whole shift without a microphone

```bash
node scripts/drive.ts               # macOS: `say` voices Sam into the live API
WRONG=1 node scripts/drive.ts       # includes a misread check digit
TOTE_LANG=es node scripts/drive.ts  # Spanish shift
```

The harness runs the same `Shift` and `VoiceAgent` code the browser does, then prints the transcript, every tool call, the final pick table and latency percentiles.

## Built with

AssemblyAI Voice Agent API · AssemblyAI LLM Gateway · React + Vite · Node 24 (no server dependencies) · Railway.

MIT licensed.
