# Terminal Contract

This document owns the durable terminal behavior contract for Parallel Code.

Use it to decide whether terminal byte handling, stream messages, recovery, input, resize,
readiness, presentation, flow control, or platform fallback behavior still fits the architecture.

This document does not own browser-lab workflow, profiling recipes, or every current timeout and
byte constant. Those belong in [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)
and the owning implementation files.

## Ownership Map

- `electron/ipc/pty.ts` owns real PTY state: process lifecycle, output bytes, scrollback,
  `outputCursor`, terminal-state mirrors, PTY geometry, pause/resume state, and recovery payloads.
- `electron/ipc/agent-handlers.ts` owns typed IPC validation and serialization for terminal
  recovery, input, resize, pause, resume, and lifecycle requests. It must not invent recovery
  policy outside the PTY owner.
- `electron/ipc/terminal-recovery.ts` owns shared recovery serialization and restore-pause
  bracketing for Electron IPC and websocket control-plane callers.
- `server/browser-channels.ts`, `server/browser-websocket.ts`, and
  `src/lib/browser-channel-client.ts` own transport validation, routing, channel binding, binary
  frame handling, fanout, and transport degradation. They must not reinterpret PTY bytes or recovery
  truth.
- `src/lib/scrollbackRestore.ts` owns renderer-side recovery request batching. It chooses request
  timing, not recovery meaning.
- `src/components/terminal-view/terminal-session.ts`,
  `terminal-input-pipeline.ts`, `terminal-output-pipeline.ts`, and
  `terminal-recovery-runtime.ts` own the desktop/browser terminal lifecycle facade, input queueing,
  output pacing, flow-control calls, and recovery application.
- `src/components/TerminalView.tsx` owns presentation, focus, visibility, surface tiering, and DOM
  attributes. It consumes terminal status and presentation state; it must not own recovery kinds.
- `src/remote/ws.ts` and the remote/mobile shell consume the backend output, scrollback, status,
  collaboration, and task-control streams. Remote/mobile may project a smaller UI, but it must not
  create a separate terminal recovery model.
- `src/lib/terminal-shortcuts.ts` owns terminal shortcut policy. Terminal sessions consume the
  returned action.
- Electron clipboard-image access belongs behind typed IPC (`ResolveClipboardPaste`,
  `SaveClipboardImage`, `SaveDroppedImage`). Terminal presentation code may request a resolved paste
  payload or save dropped files through that seam, but it must not read native clipboard images
  directly.

## Task And Session Roles

Task execution mode and Git location are independent contracts. Terminal code must preserve that
distinction instead of inferring either one from the current PTY list:

- `Task.taskMode` is explicit durable truth. Missing legacy values normalize to `agent`; an empty
  `agentIds` array does not imply `terminal` because collapsed agent tasks also have no live agents.
- Agent-mode tasks own one or more AI-agent PTYs and may also own auxiliary task shells.
- Terminal-mode tasks own task-scoped shell PTYs and never mount or spawn an AI-agent runtime.
- A standalone `Terminal` is scratch-shell state outside a task. It is not a terminal-mode task and
  does not acquire task-level Git, review, plan, or watcher ownership.
- `isShell` identifies PTY/session behavior; it does not decide whether task watchers start. The
  narrow `startsTaskWatchers` attach capability lets the primary shell of a terminal-mode task
  establish or restore the watcher ownership that an agent attach normally starts. Secondary task
  shells and standalone terminals must not request it, and backend validation rejects the flag for
  non-shell sessions or sessions without a working directory.

## PTY Byte Fidelity

PTY output is byte truth. The backend records bytes before presentation:

- PTY data is captured as bytes at the backend boundary. If the PTY runtime supplies strings, the
  backend encodes that string once for the byte stream; if the PTY runtime supplies bytes, the
  backend preserves those bytes directly.
- The backend appends bytes to scrollback and increments `outputCursor` by byte length on the hot
  path; utf8 decoding plus supervision, port, and input-trace scans and terminal-state-mirror
  writes happen once per batch flush on the already-batched buffer (tagged with the cumulative byte
  cursor), and they run even when no channel is attached so unattached agents keep supervision
  truth. Flush-time scanning preserves byte-identical end state because tail concat+slice is
  associative.
- `outputCursor` is a byte cursor over backend PTY output, not a line count, render count, or UI
  scroll position.
- Transport may coalesce adjacent `Data` payloads, choose binary frames for channel delivery, or
  queue data under backpressure, but it must preserve byte order and content.
- Renderer pacing may split, queue, suppress live writes during hibernation, or batch writes to
  xterm, but it must keep recovery history and rendered cursor accounting in byte units.
- No layer may strip ANSI/control bytes, normalize line endings, or decode/re-encode terminal
  stream bytes for policy reasons unless it is explicitly presenting a derived preview or diagnostic
  side channel outside the terminal surface.

## Terminal Stream Messages

The terminal stream uses a small vocabulary:

- PTY channel payloads are `Data`, `RecoveryRequired`, and `Exit`.
- Browser channel transport wraps PTY payloads in `channel` messages or binary channel frames.
- Remote/mobile may use the legacy `output`/`scrollback` vocabulary or opt into structured
  `terminal-stream` messages plus `terminal-recovery-request`,
  `terminal-startup-recovery-request`, and `terminal-recovery-result`.
- `Data` carries bytes. In JSON it carries base64. In binary channel frames it carries raw bytes
  plus a channel id header.
- `RecoveryRequired` means a client or channel can no longer trust continuous delivery and must ask
  the backend recovery contract for state. It is not permission to replay historical bytes through
  the live `Data` stream.
- The backend PTY owner's internal `Exit` event carries the exact current `taskId`, lifecycle
  generation, nullable exit code, a signal normalized once to `string | null`, and the bounded
  diagnostic tail. Native `null`, `undefined`, and node-pty's numeric zero sentinel all normalize
  to `null`; a real signal normalizes to its string form. Transport adapters may rename fields for
  their wire schema, but must not infer task identity or renormalize native exit metadata. `Exit`
  does not replace scrollback or recovery state.
- `channel-bound` only acknowledges channel binding. It is not terminal readiness.

Transport files validate message shape, reject malformed payloads, route by channel or message
type, and surface command-result acceptance or rejection. Domain decisions stay with the backend
PTY, task-command control owner, or terminal lifecycle owners.

## Input And Resize Ordering

Terminal input and resize are PTY mutations and follow task-command control:

- Browser and remote clients must include the task-command controller context where required.
- Transport may validate, route, and return command results; it must not bypass task-control truth.
- Renderer input queues may hold local input while recovery, reconnect, or control state is
  unsettled, but queued input must drain only after the terminal is allowed to accept real input.
- Resize commits are transactional. The renderer may coalesce repeated geometry changes to the
  latest size, but a committed PTY resize remains an explicit backend mutation.
- Reattaching an existing session must not implicitly resize the shared PTY. Recovery responses
  carry backend `cols` and `rows`; the renderer must align or reject geometry-sensitive recovery
  instead of pretending local fit changed backend truth.
- During recovery, queued resize and queued input drain after fit, recovery, restore pause/resume,
  and presentation readiness gates settle.
- Request acceptance means the backend accepted the mutation. Visible echo or redraw is still an
  output/recovery readiness concern.

## Recovery Kinds

Backend terminal recovery returns exactly these recovery kinds:

- `noop`: the renderer is already at the backend cursor. The renderer updates cursor accounting only.
- `delta`: the backend can prove the missing byte suffix by `outputCursor` or rendered-tail overlap.
  The renderer appends the returned bytes without resetting the terminal.
- `snapshot`: the backend cannot prove continuity or must fall back to a compact scrollback state.
  The renderer may reset and replay the returned scrollback bytes.
- `terminal-state`: startup recovery can return serialized backend terminal state from the
  terminal-state mirror. The renderer may reset and apply this state after aligning geometry.
- `tail-needed`: a cursor-claiming request missed the retained window and the capped snapshot would
  truncate retained scrollback. The renderer answers with exactly one bounded (64KB) rendered-tail
  re-request (phase two, without a cursor claim) so the backend can prove a delta; the phase-two
  response resolves to one of the other kinds.

Only `snapshot` and `terminal-state` are full-state recoveries. Only full-state recovery may show
blocking `restoring` UI or call `term.reset()`. `noop` and `delta` are non-destructive continuity
paths and should not show blocking restoring UI.

Visible non-shell startup recovery may use the startup recovery batch path. Visible shell attach,
hidden attach, reconnect, and non-startup recovery stay on their documented recovery paths. Changing
that split is a terminal contract change.

Recovery request and pause lifetime rules:

- A terminal attach is one pipelined `AttachTerminalSession` round trip. A managed-agent or
  managed-primary-shell request is identity-only: it carries no command, args, cwd, environment,
  resume flag, runner profile, replacement flag, or other renderer-selected process policy. The
  backend first derives canonical ownership and resolves an exact
  `(taskId, sessionId, isShell, generation)` attach or an owner-admitted one-shot restore. It binds
  the output channel only after exact identity validation; an identity, task, or session-state
  denial performs no bind, spawn, watcher, pause, or identity mutation. A later
  `channel-unavailable` result can follow an independently admitted backend restore whose process
  remains backend-owned; it never authorizes a second renderer-selected spawn. An explicit
  compatibility-shell or Arena-transient
  request may use the compatibility creation path only after both managed owners classify the
  identity as unmanaged. The old `SpawnAgent` request is retired and always fails closed.
- After that ownership decision, the backend captures the initial recovery entry in the same tick.
  Ordering guarantee: the recovery cursor is captured before any `Data` frame is sent on the newly
  bound channel, so attach replay never races live output. Because of that ordering guarantee,
  output queued while the initial attach entry waits for apply is strictly post-cursor continuity:
  the renderer must keep it and flush it after apply, never drop it. A compatibility/Arena request
  carries optimistic geometry (last-known or 80x24); attach-to-existing never resizes, and fresh
  compatibility/Arena spawns use the requested geometry. Fit gates paint, never spawn.
- Reconnect and background ensure are identity recovery, not restart commands. Clean backend
  restart is admitted only by a durable one-shot permit written after the global runner stop is
  proven; crash/unclean exit writes no such permit. A permit is moved to an in-progress phase before
  process creation, so a second crash is ambiguous and fails closed instead of duplicating a PTY.
- An initial attach claims the renderer's true rendered cursor (0 on a fresh mount), which keeps
  reload reattach on the non-destructive delta path. Cursor-hit deltas are uncapped by design (live
  continuity must not be truncated), with one exception: a fresh-mount cursor-0 delta has no
  rendered history to preserve and is a full-state transfer in disguise, so when it exceeds the
  requested `snapshotByteLimit` the backend resolves it to the capped snapshot instead of shipping
  the entire retained ring inline.
- Non-attach recoveries (reconnect, backpressure, hibernate) are cursor-first: they carry
  `outputCursor` and a `snapshotByteLimit` only, never a rendered tail. The backend keeps the
  cursor-hit delta fast path and caps every snapshot (including reconnect snapshots) at the
  requested limit; `tail-needed` is the only path that requests renderer bytes, and it is bounded.
- The backend owns the restore pause lifetime for batched recoveries: every batched recovery
  response (and the attach RPC) holds its own request-scoped `restore` pause under a unique
  `batchPauseId`, even when the agent is already paused — restore pause leases stack, so one
  client's release cannot expose another client's pre-apply window. On initial attach, the
  renderer establishes its local output-flush barrier and releases the response's pause before
  awaiting fit or paint; it keeps all post-cursor `Data` queued until the captured entry applies,
  then flushes it in order. Fetched recoveries release every pause id they observe
  (geometry-mismatch re-fetches and `tail-needed` phase two can each mint one) fire-and-forget
  (`ReleaseTerminalRecoveryPause`) after applying or abandoning the entry. A 5s server
  auto-resume timer covers a lost release but is never the normal readiness path. Batched
  recoveries carry zero
  per-terminal `PauseAgent`/`ResumeAgent` round trips; the explicit pause/resume IPC remains for
  non-batched callers (for example renderer-loss blocking flows and scrollback batch reads).

## Cursor, Readiness, And Presentation

Terminal readiness is stricter than DOM existence.

`data-terminal-status` values mean:

- `binding`: session wiring or backend channel binding is not complete.
- `attaching`: initial attach, fit, or first-mount readiness is still stabilizing.
- `restoring`: a blocking recovery path is running.
- `ready`: fit, recovery gating, restore pause/resume, and queued input/resize drains are complete
  enough for real interaction.
- `error`: the session failed and must not accept terminal input.

`data-terminal-presentation-mode` values mean:

- `live`: the user sees the real xterm surface and stdin may be enabled when control allows it.
- `loading`: the live surface is masked and input must be blocked.
- `error`: the terminal failed.

Cursor blink follows presentation truth, not focus alone. A cursor may blink only when the terminal
is focused, ready, live, not peer-controlled, not render-hibernating, and not restore-blocked.
Recovery, hibernation wake, and deferred resize must suppress stale cursor presentation until the
surface is trustworthy again.

`data-terminal-live-render-ready` is the single "safe to reveal" signal: it is present exactly when
the session is `ready`, the presentation mode is `live`, and the terminal is focused or visible.
Placeholder removal, surface swaps, and queued-input indicator teardown must key off this
transition, never off loading labels or status strings.

Browser-lab and UI code should prefer structural readiness and presentation attributes over loading
copy. Loading text can change without changing the contract.

## Flow Control

Flow control has two cooperating owners:

- The renderer output pipeline decides when its live/queued/suppressed byte watermarks require
  `flow-control` pause or resume.
- The backend PTY owner applies and clears pause reasons, including channel-scoped automatic pause
  reasons for `flow-control` and `restore`.

Rules:

- Suppressed output during render hibernation still counts toward flow-control watermarks.
- A channel/client that degrades under transport backpressure should receive `RecoveryRequired`
  rather than unbounded historical `Data`.
- Clearing automatic pause reasons must happen through the PTY owner when a channel detaches,
  recovers, or loses its last subscriber.
- Manual pause is separate from automatic `flow-control` and `restore` pause reasons.
- Flow-control recovery must leave the PTY resumable after the renderer drains below the low
  watermark or after recovery drops a queued backlog.

## Scrollback And Budget Owners

Scrollback and recovery budgets are byte budgets, not line budgets.

Current budget owners:

- `electron/ipc/pty.ts` owns PTY scrollback retention, output batching, diagnostic tail retention,
  input batching, startup recovery caps, and backend recovery cursors. Exit diagnostics retain at
  most 8 KiB and 50 non-empty lines; UTF-8 decoding must not expand the emitted diagnostic beyond
  that byte budget.
- `server/browser-channels.ts` owns browser channel pending-queue budgets, coalescing budgets, and
  degraded-client thresholds.
- `src/components/terminal-view/terminal-output-pipeline.ts` owns renderer output queue
  watermarks, rendered recovery history, direct-vs-queued write thresholds, and hibernation
  accounting.
- `src/components/terminal-view/terminal-recovery-runtime.ts` owns attach/recovery request tail
  limits, snapshot request limits, replay chunk sizes, and startup apply pacing.

Do not create alternate scrollback or recovery caps in desktop shell, remote/mobile shell,
transport glue, or presentation components. If a budget changes behavior, update the owning
implementation, owner-local tests, and this contract when the semantic boundary changes.

## Desktop, Browser, And Mobile Parity

Electron desktop, browser desktop, and remote/mobile may use different transports and UI
affordances. They must share terminal truth:

- PTY lifecycle, bytes, cursor, geometry, pause state, recovery payloads, task-command control, and
  backend status come from backend owners.
- Desktop/browser terminal surfaces use the same terminal-session contract and structural
  presentation attributes.
- Browser desktop uses HTTP IPC for command/query calls, websocket control messages for sequenced
  control state, and websocket channel frames for PTY output.
- Remote/mobile consumes the shared websocket control, output, terminal-stream, and terminal
  recovery vocabulary and projects a smaller agent-focused UI. It may request structured recovery
  for details, but it must not define its own `noop`/`delta`/`snapshot`/`terminal-state` recovery
  semantics.
- The remote/mobile agent list must not reinterpret task shells as AI agents. Terminal-only task
  sessions remain absent until that surface has an explicit task/session projection.
- Remote/mobile recovery results must be matched to the active request id before they are applied;
  stale startup, reconnect, or continuity responses must not overwrite newer terminal state.
- Read-only, takeover, controller, and resize authority are shared task-command-control truth across
  desktop/browser and remote/mobile.

## Desktop Terminal Capabilities

Desktop-grade terminal capabilities are shared policy, not ad hoc view behavior:

- Terminal Markdown detection is renderer-local and side-effect free. Wrapped-line reconstruction,
  Unicode cell mapping, lexical same-root filtering, and the 128-row/4,096-cell scan bounds belong
  in `src/lib/terminal-links.ts`; hover must not probe the filesystem or send IPC.
- Activation sends only task identity, an optional exact PTY selector, and the relative Markdown
  path. A task-backed PTY never supplies root authority. Only a backend-issued Arena launch
  capability may create an immutable `explicit-transient` PTY, and that authority disappears on
  replacement, kill/termination entry, disposal, or exit. Withdrawal is synchronous and coordinated
  before process or runner cleanup can yield.
- Task-content reads bind and recheck a canonical descriptor before committing a one-shot live-root
  admission. Markdown reads are capped at 5 MiB and plan reads at 2 MiB. Closing/removal must
  withdraw new admission before asynchronous runner, PTY, or worktree teardown begins.
- Terminal search is local presentation state owned by
  `src/components/terminal-view/terminal-search-runtime.ts` and its overlay. The optional
  `@xterm/addon-search` capability loads only for the first nonempty query, is attached only while
  that exact session's search overlay is open, and is disposed on close or session cleanup. Query
  input is capped at 4,096 UTF-16 code units, incremental scans are latest-generation and at most
  once per animation frame, and close invalidates pending results before returning focus. Search
  must never write PTY input, acquire task control, enter persistence or transport state, or retain
  terminal contents after its owner closes.

- Optional xterm add-ons such as WebGL and web-links may improve presentation, but they must be
  lazy-loaded and must not change byte, recovery, input, or resize truth.
- `src/lib/webglPool.ts` exclusively owns WebGL atlas repair. On macOS it queues current visible
  generations after a real foreground edge or retained nonvisible-to-visible transition; the
  remappable `app.redraw-terminals` action queues the same work on every desktop platform. The
  focused generation runs first, at most one generation runs per animation frame, and every entry
  is revalidated before `clearTextureAtlas()` followed by one full viewport refresh. Repair never
  replays bytes, requests recovery, changes renderer ownership, or touches a hidden/DOM/stale
  surface.
- Remote/mobile accepted startup or recovery payloads repaint only after the recovery write and the
  final already-buffered live write have completed. The exact terminal, agent, request, and restore
  generation must still be current; ordinary live output and watchdog/disconnect completion do not
  gain refreshes.
- Terminal keyboard ergonomics belong in `src/lib/terminal-shortcuts.ts`; terminal shells consume
  the returned action instead of open-coding platform chords.
- Native clipboard-image and dropped-file behavior belongs behind typed IPC seams. Browser and
  mobile degrade to text paste or explicit file-save paths without reading native Electron
  clipboard state directly.
- Remote/mobile can expose a smaller control surface, but task-command control, ordered input,
  ordered resize, and structured recovery must remain compatible with the desktop terminal
  contract.

## Platform Degraded Behavior

Platform differences are allowed when they are explicit and do not redefine terminal truth:

- If native Electron clipboard-image support is unavailable, typed IPC returns `empty` or `null`
  and terminal paste degrades to text/browser clipboard paths.
- Browser mode cannot read native clipboard images directly. It may use text paste and explicit
  dropped-file save paths where available.
- WebGL is an optional renderer optimization. DOM rendering must preserve the same terminal bytes,
  readiness, recovery, and cursor contract.
- Slow or busy websocket clients may degrade to recovery-required state; they must not silently drop
  bytes while pretending continuity is intact.
- Spawn failure surfaces `error` and process diagnostics. The UI must not synthesize a fake ready
  terminal when the backend could not create the PTY.
- Public-route or reverse-proxy problems should remain transport degraded behavior. They do not
  justify renderer-owned recovery shortcuts or alternate terminal truth.

## Validation Contract

Terminal changes should prove the owner seam that changed:

- backend recovery, byte cursor, pause, scrollback, and terminal-state behavior in node/backend
  tests;
- terminal shortcut policy in `src/lib/terminal-shortcuts.ts` tests;
- clipboard-image IPC and degraded returns in handler/transport tests;
- terminal-session, input-pipeline, output-pipeline, and recovery-runtime state machines in
  owner-local Solid/runtime tests;
- real focus, presentation, browser channel degradation, reload/reconnect, and many-terminal
  behavior in browser/runtime tests when the behavior crosses those seams;
- architecture guard tests when a change could move recovery semantics into transport, shell, or
  presentation files.
