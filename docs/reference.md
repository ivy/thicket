# Reference

Runtime shape, the conventions every component follows, and facts about upstream
systems that were expensive to learn. The work queue itself lives in
[GitHub issues](https://github.com/ivy/thicket/issues).

## Architecture summary

Enough context to work a task without reading every other file.

**Runtime topology.** One `agentd` per unix account, each fronted by a `netd` process
holding that agent's tailnet identity. `netd` terminates TLS on the tailnet and proxies
to `agentd` over a unix socket; `agentd` has no network listener. A single `bridge`
process holds one Slack Socket Mode connection per agent and acts as an A2A client.
Local Claude Code reaches the same agents through an MCP server that wraps the same A2A
client, and a shell script reaches them with `thicket send` — the same client again,
with one extra route for the agent of the account it runs in (see
[Reaching an agent from a script](#reaching-an-agent-from-a-script)).

**Identity.** An agent is a `(host, unix user)` pair. Each gets a tailnet node tagged
`tag:thicket-<name>`, so ACLs express which agents may call which. Tags arrive at
`agentd` as a header that `netd` sets from a verified `WhoIs` lookup.

**Session model.** A Slack thread maps to an A2A `contextId`, not to a task. A2A tasks
are immutable and terminal, so each turn creates a new `Task` within the same context.
`contextId` is derived as `uuidv5(channel_id + ":" + thread_ts)` and doubles as the
Claude Agent SDK `sessionId`, so thread identity is computed rather than stored — except
for a thread the agent opened itself. A message posted with `post_message` from a
session (a `thicket send` turn, a scheduled run) anchors the thread it starts to that
session's `contextId`, so a person who replies under it continues the conversation that
wrote it rather than opening one that has never heard of it. A thread already in
conversation keeps its own context; a post into it is just a message there.

**Configuration.** `agents.yaml` in git is the source of truth. The provisioning CLI
renders it into Slack app manifests, per-account XDG config, and tailnet identities. At
run time there is no shared config: each agent serves its own `AgentCard`.

## Conventions

- Paths follow XDG. Config `~/.config/thicket/`, state `~/.local/state/thicket/`,
  runtime sockets `$XDG_RUNTIME_DIR/thicket/`. Nothing lives in `/etc`.
- systemd **user** units, named `thicket-<component>.service`. No `%i` templates —
  the unix user is the instance.
- Every generated artifact is reproducible from `agents.yaml`. If something must be
  hand-edited after generation, that is a bug in the generator.
- Outbound traffic leaves an account through its own `netd`, which admits only the
  destinations `egress_allow` names — by name, never by address. Nothing configured
  means no egress.

## Reaching an agent from a script

`thicket send AGENT [MESSAGE|-]` hands one message to one agent from anything that
can run a command — a git hook, a systemd path unit, a cron job. It is the third
caller of the A2A front door after the bridge and `thicket mcp`, and it adds no
protocol: a `SendMessage`, stamped `thicket.trigger: send`, in a fresh `contextId`
unless `--context ID` names one to continue.

```sh
thicket send ops "media pushed proposal/media/base-change; review it"
thicket send --wait media "main changed under your zone; pull and apply"
sed -n 's/^ref=//p' "$event" | thicket send ops         # the message from stdin
```

**Two modes, one flag.** Without `--wait` the command returns as soon as agentd has
the task (`returnImmediately` on the wire), prints the task and context ids, and
exits `0` — the turn runs on. With `--wait` it blocks until the turn ends, prints the
reply on stdout and the coordinates and final state on stderr, so a script capturing
stdout gets the reply alone. Exit codes are the contract: `0` accepted or completed,
`1` the agent took the message and the turn ended in any other state, `2` usage, `3`
the message never reached the agent — unknown, unreachable, or refused, with the
reason on stderr.

**A reply is never written into a void.** A fire-and-forget send tells the model so
in its preamble — that nobody is reading, and that anything the operator needs to
know goes through its Slack tools — and the turn's reply is kept in the agent's task
store and journal either way, retrievable by task id (`agent_task_status` over MCP,
`thicket journal`). Anything that goes wrong on the agent's side is a `failed` task
there, not a lost line on a hook's stderr.

**Two routes, and the trust model of each.** Which one a send takes is decided by
the account it runs in, never by a flag:

- *This account's own agent* — `agentd.json` beside the roster names it — is reached
  over agentd's own unix socket, the one netd proxies to. That socket is mode 0600
  inside a 0700 runtime directory, so the kernel admits only the account itself (and
  root): opening it *is* the identification. The caller stamps its unix user name in
  `X-Thicket-Local-User`, and agentd admits the request only if that name is the
  account agentd runs as. The header is needed because netd proxies to the very same
  socket — without it, a request that arrived tagless would be indistinguishable from
  a proxy that forgot to stamp, which agentd rightly refuses. netd discards every
  inbound `X-Thicket-*` header, so the local name can never arrive from the tailnet,
  and a peer tag that is not allowed does not become allowed by adding one.
- *Every other agent* is reached the way `thicket mcp` reaches it: through this
  account's netd egress socket and the tailnet, arriving with whatever tag this
  account's netd advertises and admitted by the far agent's `allowed_peer_tags` — the
  same ACL, the same allow-list, no new path across a trust boundary. An account with
  no netd and no agent of its own has no route, and the command says so (`3`).

On a host where the operator's account runs an agent of its own, a hook running as
the operator reaches that agent over its socket, and every other account's agent as
the operator's tag over the tailnet. There is deliberately no host-local shortcut
between accounts: the network layer is where privilege boundaries are enforced, and
a local path that skipped it would have to reimplement the ACL to be safe.

## External references

Verified against upstream; re-check before assuming any of it drifted.

| Fact | Source |
|---|---|
| A2A `Task` is immutable once terminal; refinements start a new task in the same `contextId` | `docs/topics/life-of-a-task.md` in `a2aproject/A2A` |
| Agents use `contextId` to manage LLM context | same |
| `@a2a-js/sdk` v1.0.1 provides server, client, `TaskStore`, `AgentExecutor`, push notifications | npm |
| Slack agent sessions are app-scoped and keyed by `channel_id` + `thread_ts` | https://docs.slack.dev/ai/agent-sessions |
| `agents.sessions.setStatus` and `assistant.threads.setStatus` are complementary, not successive: the first drives the session lifecycle (`active`/`processing`/`suspended`/`closed`, the loading indicator and stop button), the second writes the prose line under the app's name. Only the latter's accepted *scope* is narrowing. | https://docs.slack.dev/reference/methods/agents.sessions.setStatus, https://docs.slack.dev/reference/methods/assistant.threads.setStatus |
| Slack clears the prose status line on its own: the app sending anything into the thread clears it (a `chat.appendStream` chunk counts), and a two-minute timeout clears it otherwise. It is a line to re-assert, not a line to set once. | https://docs.slack.dev/reference/methods/assistant.threads.setStatus |
| A message carrying an upload arrives subtyped `file_share`; `url_private_download` needs `files:read` and the bot token | https://docs.slack.dev/reference/methods/files.info |
| `chat.appendStream` takes either `markdown_text` or `chunks`, never both, and a stream that has carried a chunk rejects the top-level form | https://docs.slack.dev/reference/methods/chat.appendStream |
| Socket Mode removes the need for a public request URL | https://docs.slack.dev/apis/events-api/using-socket-mode |
| Free Slack plan caps installs at 10 apps | https://slack.com/help/articles/115002422943 |
| `tsnet.Server` exposes `AdvertiseTags`, `Dial`, `LocalClient().WhoIs` | https://pkg.go.dev/tailscale.com/tsnet |
| `@slack/socket-mode` detects a dead socket in seconds via its own ping loop, but reconnection fetches the wss URL through a WebClient whose default `retryConfig: {retries: 100, factor: 1.3}` retries invisibly and uncancellably for up to hours; bound it via `clientOptions.retryConfig`. Holds under Bun: with the bound in place a refused `apps.connections.open` surfaces to the supervisor in ~350ms, which then backs off visibly (1s, 5s, 15s, 60s) | `@slack/socket-mode@2.0.7` `dist/src/SocketModeClient.js`, `SlackWebSocket.js`; re-observed under Bun 1.4.0, 2026-08-29 |
| A `createSdkMcpServer` instance serves exactly one session: the second session to receive the same instance reports the server "failed to connect". Build a fresh instance per subprocess generation. Holds under Bun: two threads against one compiled agentd each drove the toolbelt | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247; re-observed under Bun 1.4.0, 2026-08-29 |
| `chat.startStream` requires `recipient_user_id` and `recipient_team_id` when streaming anywhere that is not a DM (`missing_recipient_team_id` otherwise); the team id comes from `auth.test` | https://docs.slack.dev/reference/methods/chat.startStream, observed live |
| `chat.postMessage` truncates text past 40,000 chars; guidance is ≤4,000 per message, and Slack may split longer ones itself at arbitrary points (observed: 4,692 chars became 3,610+1,081). A streamed message hits `msg_too_long` around ~3k chars of text plus cards | https://docs.slack.dev/reference/methods/chat.postMessage, rate-limits guide, observed live |
| Task-card icons are not emoji: the `icon` field takes `{"type":"icon","name":…}` from a fixed ~52-name set (code, globe, refine, file, edit, gear, bot, …) | https://docs.slack.dev/reference/block-kit/composition-objects/slack-icon-object |
| `chat.postMessage` `text` is parsed as mrkdwn (bold `*x*`, no `#` headings); real markdown goes in the separate `markdown_text` argument (12k cap, exclusive with `text`/`blocks`) — the dialect `chat.appendStream` chunks already use | https://docs.slack.dev/reference/methods/chat.postMessage, observed live |
| AskUserQuestion is offered to the model only when `canUseTool` is registered; a bare headless `query()` lists no such tool. With the callback present, a `PreToolUse` hook answering `permissionDecision: "defer"` ends the turn with `terminal_reason: tool_deferred` and `deferred_tool_use.input` carrying the full structured questions/options; the session's next send is the answer, and later questions defer again while the input stream stays open (a closed stream turns the deferral into a denial). Holds under Bun: the question came back as blocks and a typed answer resumed the same session | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247; re-observed under Bun 1.4.0, 2026-08-29 |
| `tailcfg.Node.Tags []string` carries peer tags | `tailcfg/tailcfg.go` |
| `actions/attest-build-provenance` refuses on a user-owned private repository: "Feature not available for user-owned private repositories. To enable this feature, please make this repository public." SLSA build provenance therefore waits on the public flip | observed, run 33239963963, 2026-08-29 |
| Creating a GitHub release attests it automatically — an `in-toto.io/attestation/release/v0.2` predicate naming the tag and every asset digest, initiated by `github` — even on a private repo with no build provenance. mise accepts it and prints "✓ GitHub artifact attestations verified", so that line alone does not prove a release was built by a workflow | observed, `gh api repos/ivy/thicket/attestations/sha256:…`, mise 2026.8.11, 2026-08-29 |
| Listing attestations is its own workflow permission: `contents: read` alone gets 403 "Resource not accessible by integration" from `/repos/{o}/{r}/attestations`, and mise fails the install rather than skipping verification. A job that installs a release needs `attestations: read` | observed, run 33240542607, 2026-08-29 |
| mise's asset autodetection scores os and arch tokens on word boundaries, so `<name>-<version>-<os>-<arch>.tar.gz` is enough: `linux-x64` and `macos-arm64` each picked their own archive with no `asset_pattern`. With no `bin_path` set, a `bin/` directory at the archive root is found and every executable in it lands on PATH | `src/backend/asset_matcher.rs`; observed on both platforms, 2026-08-29 |
| Bun ships its own `ws`, and the built-in wins over the installed package for the bare specifier — from inside a dependency's own directory too. It ignores the `agent` option outright (`createConnection` never called), so a WebSocket told to use a proxy silently dials direct. `ws/index.js` is unresolvable, a preloaded `Bun.plugin` `onResolve` is not consulted, and `bun build --compile` resolves identically. An npm alias (`"slack-ws": "npm:ws@^8.21.3"`) is the way to the real package, in both dev and compiled paths — which is why the bridge imports `slack-ws` and speaks Socket Mode itself | observed, Bun 1.4.0, `spikes/bridge-egress/`, 2026-08-30 |
| Bun cannot listen on a descriptor it did not open. `node:net` refuses with `EINVAL` ("Bun does not support listening on a file descriptor"); `node:http` resolves `listen({fd})`, reports success and then accepts nothing — a daemon that comes up mute. systemd socket activation therefore cannot work under Bun | observed, Bun 1.4.0, 2026-08-29 |
| A `bun build --compile` binary carries no `node_modules`, so `@anthropic-ai/claude-agent-sdk` cannot reach the per-platform CLI it ships as an optional dependency: the turn fails with "Native CLI binary for <platform> not found". Pass `pathToClaudeCodeExecutable` — the account's own `claude` is the right one | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247 under Bun 1.4.0, 2026-08-29 |
| ConversationRelay signs the WebSocket handshake with `X-Twilio-Signature` over the `url` attribute exactly as written — `wss://host/path`, no query, no params — validated with the account's primary auth token. The same value also arrives as `x-amzn-bedrock-agentcore-runtime-custom-twilio-signature`; the client is `Jetty/11.0.24` | observed live through Tailscale Funnel, spike #19, 2026-08-30 (`tests/fixtures/conversationrelay/*.jsonl`, the `handshake` entries) |
| The `setup` frame: `{type, sessionId "VX…", callSid, parentCallSid "", from, to, forwardedFrom, callerName "", direction "inbound", callType "PSTN", callStatus "RINGING", accountSid, customParameters {}}`. On a second `<Connect><ConversationRelay>` for the same call (from `action`), a fresh socket opens with the same `callSid`, a new `sessionId` and `callStatus "IN_PROGRESS"`, and the `welcomeGreeting` plays again | observed, `pin-spoken.jsonl`, `end-then-reconnect.jsonl`, 2026-08-30 |
| `events="speaker-events tokens-played"` arrive as `{type:"info", name:"agentSpeaking"\|"clientSpeaking", value:"on"\|"off"}` and `{type:"info", name:"tokensPlayed", value:"<text>"}` — not as their own `type`s. `tokensPlayed` fires per TTS chunk (clause boundaries, e.g. `"I heard:"` then the rest) and is the only objective record of what was actually said | observed, every fixture, 2026-08-30 |
| Flux with `partialPrompts="true"`: `prompt{last:false}` carries the cumulative transcript every 200–300 ms while `clientSpeaking` is on; the last partial already has smart-format punctuation and the `last:true` frame ~350 ms later repeats it verbatim. Nothing marks Flux's eager end-of-turn, so speculative turns through ConversationRelay have no signal to key on | observed, `pin-spoken.jsonl`, 2026-08-30 |
| A TTS voice saying "four seven two nine zero one three eight" transcribes as `"Four seven two nine zero one three eight."` — words, not digits, in one prompt — with a transient partial mishearing `one two` before `one three`. Single short words fare worse: "long" → `"Wrong."`, "preempt" → `"Prempt."`. A person in a car is still unmeasured | observed, `pin-spoken.jsonl`, 2026-08-30 |
| Our first `text` token → `agentSpeaking on` in ~320–340 ms, first `tokensPlayed` ~1 s after; the `welcomeGreeting` starts ~700 ms after `setup` | observed, 2026-08-30 |
| Keypad digits arrive as `{type:"dtmf", digit:"9"}` one per press, including during the `welcomeGreeting`, and with `interruptible="any"` a keypress is a barge-in: `interrupt{utteranceUntilInterrupt, durationUntilInterruptMs}` and TTS stops. DTMF never appears in transcripts | observed, `greeting-dtmf.jsonl`, 2026-08-30 |
| Caller hangup: socket close `1000 "Closing websocket session"`, then `action` ~0.5–0.8 s later with `SessionStatus=completed`, `SessionDuration` (s), `SessionId`, `CallStatus=completed` and the standard call parameters (no `HandoffData`/`ErrorCode` keys), then the number's `StatusCallback` (`completed` only, `CallDuration`) ~0.4–1 s after that. Ending the call from REST (`Status=completed`) produces exactly the same sequence | observed, `pin-spoken.jsonl`, `rest-update-completed.jsonl`, 2026-08-30 |
| Our `end{handoffData}`: close `1000` within ~90 ms, `action` ~0.7 s later with `SessionStatus=ended`, `HandoffData` verbatim, `CallStatus=in-progress`; the call continues with whatever TwiML `action` returns — `<Say>` played and `<Hangup/>` hung up; a fresh `<Connect><ConversationRelay>` reconnected (see the `setup` row) | observed, `end-then-say-hangup.jsonl`, `end-then-reconnect.jsonl`, 2026-08-30 |
| An outbound REST call's leg runs `<Connect><ConversationRelay>` from inline `Twiml`; on a self-call (`To == From`) both legs held relay sessions at once — three calls, no 64109. Post-dial `SendDigits` (`ww<pin>`) authenticated against the bridge, and the far end's first ~1.5 s of speech can predate the caller leg's own `setup`, so the hello arrives clipped there — a human ear is live from answer and has no such gap | observed, caller-leg spike #50, `operator-leg-dial-string.jsonl`, `operator-leg-keypad-pin.jsonl`, 2026-08-30 |
| A `sendDigits` frame queued on one leg reaches the far leg as `key` frames in order, the first 0.21 s after the frame was sent | observed, `operator-leg-keypad-pin.jsonl`, 2026-08-30 |
| The synthetic caller leg's extra hop (TTS out, Flux back): its last token queued → far side logs `speech final` median 2.08 s (n=10, 0.89–4.60 s, scales with utterance length); far side's last token queued → this leg's final transcript median 2.63 s (n=11, includes the far end's playback of the tail — 202 chars took 5.65 s). TTS through Flux comes back verbatim more often than not — a 30-number count exact, numbers as words — but "Aiva"→"Iva", and one utterance can finalize as several fragments, each a new turn, each barging the far end's reply under `interruptible="any"`; `interruptible="none"` keeps the leg's own speech uncut while its speech still barges the far end | observed, `operator-leg-*.jsonl` paired with `phone.log`, 2026-08-30 |
| Funnel `--set-path /operator` strips the mount prefix before proxying (`/operator/x` arrives as `/x`), but the handshake's `X-Twilio-Signature` is over the URL as given, prefix included (`wss://host/operator/relay/…`). The public edge can refuse for minutes after a funnel reconfig — `11200` 502 on webhooks, `64102` on the WS connect; 3 of 6 attempts in one afternoon — while tailscaled reports healthy and same-machine probes pass, because MagicDNS short-circuits the ingress: probe via public DNS with `curl --resolve`, then dial, and retry a busy | observed, `operator-leg-busy.jsonl` handshake entries, Twilio Alerts, 2026-08-30 |
| A restricted key reads Twilio Alerts (`monitor.twilio.com/v1/Alerts`) only with `twilio/monitor/alerts/list`, and `OutgoingCallerIds` only with `twilio/voice/outgoing-caller-ids/list`; without them a 401, code 70051, names the missing permission | observed, 2026-08-30 |
| Our socket dropping (no close frame) does **not** fail the call: close `1006`, then `action` ~1.2 s later with `SessionStatus=failed`, `ErrorCode=64105`, `ErrorMessage="Websocket ended"`, `CallStatus=in-progress`, and the TwiML `action` returns decides what happens next. Twilio never reconnects on its own | observed, `socket-drop.jsonl`, 2026-08-30 |
| Ten non-JSON frames: each is answered `{type:"error", description:"Invalid message received, code: 64107, <frame>"}`, the tenth closes the socket `1007 "Too many consecutive malformed messages."`, and `action` fires as for a drop (`failed`, `64105`) | observed, `malformed-frames.jsonl`, 2026-08-30 |
| 88 s of silence from both sides (default `speechTimeout`) ends nothing and sends nothing; no keepalive is needed from our side and speech afterwards is transcribed normally. The default silence budget is longer than an agent's typical tool call | observed, `long-silence.jsonl`, 2026-08-30 |
| Twilio failing to reach the WebSocket (`64102 Unable to connect to websocket URL`) or getting a 502 on the voice URL leaves the caller hearing **busy**, not an error message, and only the Alerts API (`monitor.twilio.com/v1/Alerts`) says why. Through Funnel on a laptop this happened in a window where the machine's gateway/self IP changed (`tailscale netcheck`) while the same socket was reachable from elsewhere; a deployed bridge on a fixed host should not see it, and `doctor` should read Alerts when it does | observed, 2026-08-30 |
| `POST /Calls` with `To` equal to `From` (the account's own number) is accepted: the number rings itself, the inbound leg sees `From == To`, and the caller leg's TwiML (`<Say>`, `<Play digits>`, `<Pause>`, `<Gather>`) is a synthetic caller good enough to record every frame shape without a person — `spikes/conversationrelay/call.ts` | observed, 2026-08-30 |
| Voice Insights needs **Advanced Features** on in the Console ("must be active to use this API Resource") — a toggle, not a permission; without it `/Summary`, `/Events` and `/Metrics` all answer 404 with an empty body, with the restricted key and the auth token alike. With it on, `GET insights.twilio.com/v1/Voice/{CallSid}/Events` and `/Metrics` answered within ~15 min of a call ending while `/Summary` was still 404 at 17 min (documented: partial at ~10 min, complete at ~30). The `conversation_relay` group carries `configurations` (every attribute Twilio applied, including defaults such as `interruptConfidenceThreshold=0.7`), one `dtmf` per keypress, `first_token_received`, `final_token_received{total_tokens,total_words}`, `tts_latency{latency_ms}` (161 ms for a three-word reply), `start_of_agent_speech`, `interrupt`, `end_of_agent_speech`, `call_wrap_up{duration_in_seconds,end_status}` — each stamped with the relay `session_id` and a `sequence_number`. It is a second stopwatch, after the fact; the live `tokensPlayed`/`agentSpeaking` frames remain the only one usable during a call. Documented and not yet seen: ConversationRelay events are emitted at `carrier_edge` (pass `Edge=carrier_edge` when a call's default edge differs — a PSTN call's did not), and the complete Summary carries `agent_session_summaries[]` with `tts_latency_ms`, `stt_latency_ms`, `time_to_first_audio_ms`, `application_latency_ms`, turns and interruptions per relay session. A restricted key needs `/twilio/voice/insights.call.summaries/read` and `/twilio/voice/insights.call.events/list` | observed 2026-08-30, `tests/fixtures/conversationrelay/voice-insights/`; https://www.twilio.com/docs/voice/voice-insights/api/call/call-summary-resource, …/call-events-resource, …/details-conversation-relay-events |
| A barge-in purges everything queued: with twelve sentences already sent (`last:true` included), the caller speaking produced `clientSpeaking on`, `tokensPlayed` for the fragment actually heard, `interrupt{utteranceUntilInterrupt:"Sentence 2 of", durationUntilInterruptMs:684}` and `agentSpeaking off`, and none of the remaining ten sentences ever played. The bridge need not race to stop sending, and `utteranceUntilInterrupt` is exactly what the caller heard | observed, `interrupt.jsonl`, 2026-08-30 |
| `sendDigits` is an item in the same play queue as `text`: sent while nothing is playing, the far end hears the tones ~2 s later; sent during TTS, the tones wait until the speech ends (queued behind a 70 s reply they arrive after it, so an IVR menu will have timed out); sent while the *caller* is speaking they go out at once. Each is reported back as `{type:"info", name:"tokensPlayed", value:"1234#"}`. A `<Gather>` on the far leg received `Digits=1234`, `FinishedOnKey=#` every time | observed, `idle-digits.jsonl`, `queued-digits.jsonl`, `busy-digits.jsonl`, `talking-digits.jsonl`, 2026-08-30 |
| `preemptible` on `text` marks the message that may be **cut off**, not the one that cuts: a new message flagged `preemptible:true` merely queued behind twelve sentences in flight, while a long reply sent *with* the flag was cut mid-sentence the moment a plain message arrived (`tokensPlayed` reports the fragment heard, no `interrupt` frame), and the new message played ~2 s later. Narrated progress should therefore be sent preemptible so the real answer can displace it. This is what the message reference says, once read that way: `preemptible` — "whether subsequent text or play messages from your application will stop this media playback"; `interruptible` per message overrides the TwiML attribute; and TTS starts on tokens already sent, `last` only closes the talk cycle | observed, `preempt-queued.jsonl`, `preempt-marked.jsonl`, 2026-08-30; https://www.twilio.com/docs/voice/conversationrelay/websocket-messages |
| A PIN keyed as post-dial DTMF arrives intact with no greeting configured: the relay socket's `setup` lands ~0.4 s after `/voice`, before the caller leg reaches `in-progress`, and eight digits sent one second after connect arrive as eight `dtmf` frames 380 ms apart starting 2.2 s after `setup` (5.2 s when keyed four seconds after connect), in order, none lost. A trailing `#` that lands after the eighth digit arrives while the reply is already speaking and barges in on it, so entry should end on the eighth digit *or* `#` and a late terminator be ignored | observed, `dial-string-pin.jsonl`, `dial-string-pin-late.jsonl` (caller leg `SendDigits`), 2026-08-30 |
| Turning the Funnel off and on again cost the first ConversationRelay connect afterwards a `64102 Unable to connect to websocket URL` — the voice webhook got through, the socket did not, and the retry 30 s later succeeded. Twilio's relay side and its webhook side do not share whatever the Funnel change had stale | observed, 2026-08-30 |
| Through netd's Funnel listener (`tsnet.ListenFunnel(":443", FunnelOnly())`), a connection from the public internet arrives with a tailnet-fabric source address (an `fd7a:…` IPv6 of Tailscale's ingress), not the caller's IP: `RemoteAddr` says nothing about who is on the internet end, which is why the public handler stamps no identity at all. Requests outside the configured prefix are refused by netd (`public: refused …`) before the upstream is touched; inside it, the bridge's own 404 answers a bare GET | observed 2026-08-30, netd on a laptop as `thicket-phone` fronting the rig's phone bridge, requests sent to the public ingress via `--resolve` |
| A ConversationRelay WebSocket held through netd's Funnel listener for 214 s (PIN, agent chosen, then silence) closed only when the caller hung up — `1000 "Closing websocket session"`, state still `connected` — with no idle timeout on either side and nothing logged in between | observed 2026-08-30, the spike's `long-session` scenario through the `thicket-phone` node |
