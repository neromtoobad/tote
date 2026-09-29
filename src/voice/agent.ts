// A small client for the AssemblyAI Voice Agent WebSocket.
// It runs unchanged in the browser and in Node 22+ (global WebSocket), which
// is how scripts/drive.ts rehearses whole shifts with synthesized speech.

export const WS_URL = 'wss://agents.assemblyai.com/v1/ws'

export type ToolDef = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  execution_mode?: 'interactive' | 'hold'
  timeout_seconds?: number
}

export type SessionConfig = {
  system_prompt?: string
  greeting?: string
  tools?: ToolDef[]
  input?: Record<string, unknown>
  output?: Record<string, unknown>
}

export type ToolOutcome = {
  result: unknown
  isError?: boolean
  /** Sent just before the tool.result, so the reply it triggers already runs
   *  under the next state's prompt and tool list. */
  update?: SessionConfig
}

export type ToolHandler = (name: string, args: Record<string, unknown>, callId: string) => ToolOutcome | Promise<ToolOutcome>

export type AgentStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error'

export type WireEvent = { dir: 'up' | 'down'; type: string; detail?: string; at: number }

type Listeners = {
  status: (s: AgentStatus, detail?: string) => void
  wire: (e: WireEvent) => void
  ready: (sessionId: string, config: unknown) => void
  userDelta: (itemId: string, text: string) => void
  user: (itemId: string, text: string) => void
  agentDelta: (replyId: string, word: string) => void
  agent: (replyId: string, text: string, interrupted: boolean) => void
  toolCall: (name: string, args: Record<string, unknown>, callId: string) => void
  toolResult: (name: string, result: unknown, isError: boolean) => void
  audio: (pcm: ArrayBuffer) => void
  /** The server decided the user barged in: flush local playback now. */
  bargeIn: () => void
  userSpeaking: (on: boolean) => void
  latency: (ms: number) => void
  ended: (info: { sessionSeconds?: number; audioSeconds?: number | null }) => void
}

type Pending = { callId: string; name: string; outcome: ToolOutcome }

export class VoiceAgent {
  private ws: WebSocket | null = null
  private listeners: { [K in keyof Listeners]?: Listeners[K][] } = {}
  private pending: Pending[] = []
  private lastTurnEvent: string | null = null
  private inHold = false
  private queue: { instructions: string; context?: string }[] = []
  private speechStoppedAt = 0
  private awaitingFirstAudio = false
  private userSpeaking = false
  sessionId: string | null = null
  ready = false
  status: AgentStatus = 'idle'

  private handleTool: ToolHandler
  private decode: (b64: string) => ArrayBuffer

  constructor(handleTool: ToolHandler, decode: (b64: string) => ArrayBuffer) {
    this.handleTool = handleTool
    this.decode = decode
  }

  on<K extends keyof Listeners>(event: K, fn: Listeners[K]) {
    const list = (this.listeners[event] ??= []) as Listeners[K][]
    list.push(fn)
    return () => {
      this.listeners[event] = list.filter((f) => f !== fn) as never
    }
  }

  private emit<K extends keyof Listeners>(event: K, ...args: Parameters<Listeners[K]>) {
    for (const fn of this.listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args)
  }

  private setStatus(s: AgentStatus, detail?: string) {
    this.status = s
    this.emit('status', s, detail)
  }

  private wire(dir: 'up' | 'down', type: string, detail?: string) {
    this.emit('wire', { dir, type, detail, at: Date.now() })
  }

  send(msg: Record<string, unknown>, detail?: string) {
    if (this.ws?.readyState !== 1) return false
    this.ws.send(JSON.stringify(msg))
    if (msg.type !== 'input.audio') this.wire('up', String(msg.type), detail)
    return true
  }

  connect(token: string, config: SessionConfig) {
    this.setStatus('connecting')
    const url = new URL(WS_URL)
    url.searchParams.set('token', token)
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => this.send({ type: 'session.update', session: config }, 'initial config')
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)))
    ws.onclose = (e) => {
      if (this.status !== 'ended') this.setStatus(e.code === 1000 ? 'ended' : 'error', `socket closed ${e.code}`)
      this.ready = false
    }
    ws.onerror = () => this.setStatus('error', 'connection failed')
  }

  sendAudio(b64: string) {
    if (!this.ready) return
    this.send({ type: 'input.audio', audio: b64 })
  }

  update(session: SessionConfig, detail?: string) {
    this.send({ type: 'session.update', session }, detail)
  }

  /** Make the agent speak without a user turn. Waits until the floor is free. */
  say(instructions: string, context?: string) {
    this.queue.push({ instructions, context })
    this.drainQueue()
  }

  end() {
    if (this.ws?.readyState === 1) {
      this.send({ type: 'session.end' })
    } else {
      this.setStatus('ended')
    }
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
  }

  private idle() {
    return (
      this.ready &&
      !this.userSpeaking &&
      this.pending.length === 0 &&
      (this.lastTurnEvent === null || this.lastTurnEvent === 'reply.done')
    )
  }

  private drainQueue() {
    if (!this.queue.length) return
    // During a hold the agent is silent on purpose; a reply.create is the
    // sanctioned way to give a status update without ending the hold.
    if (!this.idle() && !this.inHold) return
    const next = this.queue.shift()!
    if (next.context) this.send({ type: 'conversation.message', role: 'system', content: next.context }, next.context)
    this.send({ type: 'reply.create', instructions: next.instructions }, next.instructions)
    this.lastTurnEvent = 'reply.create'
  }

  // Results go out only when reply.done is the latest turn event: earlier and
  // the agent is still mid-sentence, later and a new turn has begun.
  private async flushTools() {
    if (this.lastTurnEvent !== 'reply.done' || !this.pending.length) return
    const batch = this.pending.splice(0)
    for (const p of batch) {
      if (p.outcome.update) this.update(p.outcome.update, `state → after ${p.name}`)
      this.send(
        {
          type: 'tool.result',
          call_id: p.callId,
          result: JSON.stringify(p.outcome.result),
          is_error: Boolean(p.outcome.isError),
        },
        p.name,
      )
      this.emit('toolResult', p.name, p.outcome.result, Boolean(p.outcome.isError))
    }
    this.lastTurnEvent = 'tool.result'
  }

  /** Resolve a hold-mode tool call later (e.g. a supervisor answering). */
  resolveHold(callId: string, name: string, outcome: ToolOutcome) {
    this.inHold = false
    if (outcome.update) this.update(outcome.update, `state → after ${name}`)
    this.send({ type: 'tool.result', call_id: callId, result: JSON.stringify(outcome.result) }, name)
    this.emit('toolResult', name, outcome.result, false)
    this.lastTurnEvent = 'tool.result'
  }

  private async onMessage(msg: Record<string, any>) {
    const t = String(msg.type)
    switch (t) {
      case 'session.ready':
        this.ready = true
        this.sessionId = msg.session_id
        this.wire('down', t, msg.session_id)
        this.emit('ready', msg.session_id, msg.config)
        this.setStatus('listening')
        break
      case 'session.updated':
        this.wire('down', t)
        break
      case 'input.speech.started':
        this.userSpeaking = true
        this.lastTurnEvent = t
        this.wire('down', t)
        this.emit('userSpeaking', true)
        this.setStatus('listening')
        break
      case 'input.speech.stopped':
        this.userSpeaking = false
        this.speechStoppedAt = performance.now()
        this.awaitingFirstAudio = true
        this.wire('down', t)
        this.emit('userSpeaking', false)
        this.setStatus('thinking')
        break
      case 'transcript.user.delta':
        this.emit('userDelta', msg.item_id, msg.text)
        break
      case 'transcript.user':
        this.userSpeaking = false
        this.wire('down', t, msg.text)
        this.emit('user', msg.item_id, msg.text)
        break
      case 'reply.started':
        this.lastTurnEvent = t
        this.wire('down', t)
        this.setStatus('speaking')
        break
      case 'reply.audio':
        if (this.awaitingFirstAudio && this.speechStoppedAt) {
          this.awaitingFirstAudio = false
          this.emit('latency', Math.round(performance.now() - this.speechStoppedAt))
        }
        this.emit('audio', this.decode(msg.data))
        break
      case 'transcript.agent.delta':
        this.emit('agentDelta', msg.reply_id, msg.delta)
        break
      case 'transcript.agent':
        this.wire('down', t, msg.text)
        this.emit('agent', msg.reply_id, msg.text, Boolean(msg.interrupted))
        break
      case 'reply.done':
        this.lastTurnEvent = t
        this.wire('down', t, msg.status)
        if (msg.status === 'interrupted') {
          this.pending = []
          this.emit('bargeIn')
        }
        this.setStatus('listening')
        await this.flushTools()
        this.drainQueue()
        break
      case 'tool.call': {
        const args = (msg.arguments ?? {}) as Record<string, unknown>
        this.wire('down', t, `${msg.name} ${JSON.stringify(args)}`)
        this.emit('toolCall', msg.name, args, msg.call_id)
        const outcome = await this.handleTool(msg.name, args, msg.call_id)
        if ((outcome.result as { __hold?: boolean })?.__hold) {
          // Hold-mode: the caller resolves it later with resolveHold().
          this.inHold = true
          break
        }
        this.pending.push({ callId: msg.call_id, name: msg.name, outcome })
        await this.flushTools()
        break
      }
      case 'session.ended':
        this.wire('down', t, `${msg.session_duration_seconds}s`)
        this.ready = false
        this.setStatus('ended')
        this.emit('ended', { sessionSeconds: msg.session_duration_seconds, audioSeconds: msg.audio_duration_seconds })
        this.close()
        break
      case 'session.error':
        this.wire('down', t, `${msg.code}: ${msg.message}`)
        if (['UNAUTHORIZED', 'FORBIDDEN', 'agent_init_failed', 'agent_timeout', 'session_expired'].includes(msg.code)) {
          this.setStatus('error', msg.message)
        }
        break
      default:
        this.wire('down', t)
    }
  }
}
