# Discord bridge

The design the Discord milestones assume. It states what the bridge is and where its
edges are; the issues say what to build next. It is a third bridge beside Slack and the
phone.

## What it is

The fleet as a set of Discord apps, one per agent, in a server the operator owns. An
agent is reachable by DM, by mention in any channel it can see, and in the thread a
mention opens, and it answers the way Discord's own features do: a card that updates in
place while it works, a form when it has a question, buttons when it needs a yes, a
thread per conversation, a nickname and status per server.

It is also a surface other people can watch. A Discord server is free, and its channel
permissions decide who sees an agent at work, so a collaborator or a household can share
a channel with the fleet without seeing the rest. Watching is not driving: who may give
an agent work is the bridge's own allow-list (see Trust), never a channel permission.

## Shape

`apps/discord` (`thicket-discord`) is built like the Slack bridge: it translates Gateway
dispatches and interactions into `message/send` on the right agent and carries task
events back, runs in its own unix account behind its own netd, and talks to Discord
directly. `packages/executor` learns two metadata keys, a trigger value and a preamble line;
`apps/agentd` learns a second toolbelt.

```
operator ─Discord client─► Discord ◄─wss Gateway (outbound)─ thicket-discord ─A2A over tailnet─► netd ─► agentd ─► session
                               ▲                                   │
                               └──────── REST through netd egress ─┘   agents ─toolbelt over tailnet─► thicket-discord
```

Discord never calls the bridge. Messages, interactions and thread events all arrive on
the Gateway, an outbound websocket; replies and edits go out over REST. Both leave
through the bridge's netd, so the process holds no network of its own. The only listener
is the agent-facing toolbelt on the tailnet, as the Slack bridge already has. There is no
Funnel and no public hostname.

| Owner | Responsibility |
|---|---|
| Discord | identity, channel permissions, the client on every device, threads, forms, file hosting |
| netd (egress) | the only way out: `discord.com`, `*.discord.gg`, `cdn.discordapp.com`, `media.discordapp.net` |
| `thicket-discord` | one Gateway session per agent with resume across restarts, the operator allow-list and loop guard, the turn table, the turn card and its edit budget, questions as cards and forms, thread creation, the file proxy, the toolbelt, the heartbeat file |
| `packages/executor`, `apps/agentd` | `thicket.discordChannel` and `thicket.discordThread`, a preamble line, a Discord toolbelt beside the Slack one |
| each discord-enabled agent's account | the work; its egress gains only the bridge's name |
| `agents.yaml` + `provision` | which agents are on Discord and their channel bindings; nickname, bio, description and commands rendered from the `AgentCard`, the avatar from the roster's `icon` |
| the bridge's 0600 config (never the roster) | application id and bot token per agent, the server id, the operator allow-list |
| the operator, once per agent, in the Developer Portal | creating the application and minting its token; there is no API for either |

## Who may drive an agent

Discord permissions say who can see a channel. They say nothing about who may give a
privileged agent work, and anyone who can post where an agent can read can mention it.
So authority is the bridge's, as it is the phone bridge's: `discord.json` carries
`operators`, a list of Discord user ids, and a message from anyone else is never a turn
and never context. An interaction from anyone else, a Stop, a pick, a form, is refused
with an ephemeral reply. The list is fleet-wide and starts with one id, the operator's.

Live tests need a second author, and Discord has no sanctioned way to automate a user
account, so `test_bots` names bot user ids the loop guard admits as if they were
operators, bot flag and all. It is honoured only when `THICKET_DISCORD_TEST_HARNESS=1` is set, and
`doctor` warns when a deployed config carries it.

## The turn table

Every agent's Gateway session receives every message in a shared channel, so each
engine classifies every message the same way. A mention is the bot user appearing in the
message's `mentions`, which a reply with the ping on also does. A thread is engaged by an
agent when the bridge holds a context row for it.

| Message | What this agent's engine does |
|---|---|
| from a server other than the configured one | ignored |
| author is a bot or a webhook (a listed test bot excepted), author missing, author not an operator, or `type` not 0 (default) or 19 (reply) | ignored; the shape is logged |
| in a DM channel | a turn in the DM context |
| in a guild channel that is not a thread, mentions this agent | a turn; the bridge opens a public thread from the message, and the thread is the context |
| in a guild channel that is not a thread, no mention of this agent | ignored |
| in a thread whose parent is a forum channel bound to this agent | this agent is an answerer from the post's first message, which is itself a turn, so the post is a session |
| in a thread, mentions this agent | a turn; the thread is engaged from now on if it was not |
| in a thread this agent is engaged in, no mention, no other engaged agent mentioned | a turn if this agent is one of the thread's answerers; context only (`thicket.shouldQuery: false`) if it is not |
| in a thread this agent is engaged in, another engaged agent mentioned | context only |
| in a thread this agent is not engaged in, no mention | ignored |

A thread's **answerers** are the agents mentioned in the message that opened it, all of
them, each recorded as such in its own engine's context row when it creates or joins the
thread; an agent mentioned into the thread later hears everything but answers only when
addressed. That is what makes unmentioned follow-ups native, and the reason the content
intent is required. The answerer record is the bridge's own, never Discord's `owner_id`,
which names whoever's bot won the creation race. Message types 20 (a slash command's
response) and 21 (the starter message echoed into a new thread, under its human author)
are not conversation.

**Several agents mentioned in one channel message.** Each engine tries to open the
thread. A message can have one, so all but the first get `MESSAGE_ALREADY_HAS_THREAD`
(code 160004), fetch the message, and take its `thread.id`. Every mentioned agent
engages that thread and answers in it.

**The thread.** Named from the message text, flattened and cut at 100 characters, with
`auto_archive_duration` 1440: a day, because a post into an archived thread unarchives
it, so a context stays reachable for as long as the thread exists, and a server holds at
most 1,000 active threads. The spike recorded 60; the value is a design choice.

**Project channels.** A channel bound to a workspace in the roster runs its turns in
that checkout, as Slack's `channels` do. A message in a thread carries the thread id as
its channel, so the parent is looked up once and cached; while that lookup fails the
turn is refused out loud, as the Slack engine refuses an unresolved binding. Forum
channels are the native fit for a bound workspace and come after plain channels work:
the table's forum row makes every post a session, and the post's tags carry the task
state.

**Queueing and context.** Both roster values of `queueing` work as on Slack. `context:
replay` reads the thread back through message history, which the permission set below
includes.

## The conversation, from the agent's side

Every message carries the **envelope**, `thicket.envelope`, the shape every human surface
shares and the executor renders into one preamble: the surface and place (channel,
thread, message, all ids), the author with a name where Discord offered one and whether
they are the operator, who the message mentions, and what it points at beyond its words:
the replied-to message with its author and text, forwarded messages, links, and the
attachments those carry. The Slack bridge writes the same envelope with what Slack gives
for free. `thicket.discordChannel` and `thicket.discordThread` stay beside it for the
toolbelt. The agent's own mention reaches it as its name, `@hearth`, because the id
means nothing from inside the session; other people's mentions keep their ids, which the
toolbelt needs.
The preamble says the agent is in a Discord server, channel and thread by id, never what
was said there. Files arrive as URL parts pointing at the bridge's file proxy.

`messageId` is `discord-{channelId}-{messageId}`. `taskId` is agent-minted, one per
turn, as everywhere. Delivery is at least once: the Gateway client awaits the engine's
handler for a dispatch and persists the sequence only when it returns, so a crash or a
thrown handler leaves the sequence behind the dispatch and the next resume redelivers
it; the handler records the message id first, and a repeat is dropped.

**Context ids**, following `deriveSessionId`:

- A thread: `uuidv5("discord:" + threadId)`. Threads are channels with their own ids.
- A DM: `uuidv5("discord:" + channelId)` until the operator asks for a fresh one. `/new`
  in the DM mints `uuidv5("discord:" + channelId + ":" + interactionId)` and records it
  in the bridge's `contexts` table, the override table an agent-minted context id also
  uses. Derivation is the fast path; a recorded override wins. `/new` is a global
  command with the bot-DM context; the spike registered only a guild command, so the DM
  route is documented and not yet recorded.

## Presentation

Every reply is one Components V2 message per task, the turn card, edited in place. It is
a fixed shape of eight components counting the nested ones, so the 40-component cap
never comes near; a Text Display may not be empty, so the steps and answer displays are
omitted until they have content:

```
container (accent colour = state)
  section: status line                      accessory: Stop button
  separator
  text display: one line per activity step   (⏳ ✅ ❌ title)
  separator
  text display: the streamed answer
```

- **Streaming is editing.** The executor emits text deltas far faster than the edit
  budget. The bridge keeps only the latest rendering per card and flushes once a
  second per channel, round-robin across the channel's open cards, so two agents in
  one thread share the budget rather than exceed it. The interval is seeded by the
  recording and driven by the `X-RateLimit-*` headers, never hardcoded.
- **Rollover.** A message holds 4,000 characters of displayable text across all its
  components, so the text budget is that minus the status and step lines. Past it the
  card is frozen with its text and a new card opens below, posted with
  `SUPPRESS_NOTIFICATIONS`, carrying the status, the steps still running and the last
  three closed, so a tool-heavy turn cannot carry more steps than the budget.
- **What state holds.** An edit replaces the whole message, so the bridge persists each
  card's rendered text and steps with every flush, beside the task id and message id.
  A restart resubscribes to the task and keeps editing the same card from that record;
  nothing is rebuilt from the agent.
- **The final edit.** A completed turn sheds the card: the container, the status line
  and the accent bar were the presentation of work in progress, and a finished answer
  reads as a message, with the steps beneath it as subtext. Failed, stopped and
  waiting keep the container in their colour, with Stop removed and every step
  closed, because there the state is the point.
- **Thinking.** The typing indicator every eight seconds while a turn is open. A turn
  that starts from a slash command answers with the deferred callback, which shows
  Discord's own loading state; the card is then posted as an ordinary message and the
  deferred original is edited to point at it, so no interaction token is used past its
  first minute.
- **Follow-ups.** An operator message arriving in a thread with an open card freezes
  the card: one edit that removes Stop, keeps the steps as they stand, and marks the
  status line "continued below". The next text or step update opens a new card below the
  message, so an answer never renders above the question that changed it. The Slack
  engine's stale-stream cut, applied to cards.
- **Notifications.** Edits never notify. The card follows the message that triggered
  it and never quotes it; a state that needs the operator, a question, a failure,
  authentication required, is posted as a reply to that message with the ping on. Completion rings nothing beyond the thread's own notification setting.
  `allowed_mentions` is `{parse: [], replied_user}` on every send, so agent text can
  never ping a person, a role or everyone.
- **Questions.** At input-required a question card is posted below the turn card: one
  string select per question, multi-select where the question allows it, an **Other…**
  button that opens a form with one text input per question, and **Submit**. Discord
  sends each pick as its own interaction with no message state, so picks are recorded
  in the bridge's `questions` table and the card redrawn to show them; Submit sends the
  answers as the thread's next message to the agent, exactly what a typed reply is, and
  the card is redrawn answered. A non-empty **Other…** text for a question replaces its
  pick. A single yes/no question is two buttons and answers on tap; any other question,
  even alone, is a pick and then Submit, so a mis-tap on a phone is not an answer. Only
  operators may answer.
- **Degradation.** Presentation is never worth losing the answer. A card the bridge can
  no longer edit stops being edited and the answer text is buffered; at the terminal
  state it is posted plain, split by the markdown splitter at 2,000 characters.

## Rate limits

Per bot token, per channel unless noted. The edit, send and typing routes behave as a
bucket of five that refills one per second: a burst of five, then one a second, and a
sixth within the second is refused with `retry_after` of 0.3 to 0.6 s. Thirty-one edits
of one card at one per second drew no refusal.

| Route | Budget | Source |
|---|---|---|
| send a message | 5, refilling 1/s | recorded |
| edit a message | 5, refilling 1/s, its own bucket | recorded |
| typing indicator | 5, refilling 1/s, its own bucket | recorded |
| create a thread from a message | 50 per 300 s | recorded |
| nickname | 20 per 300 s per server | recorded |
| command registration | 2 per 30 s | recorded |
| global | 50 per second, interaction callbacks exempt | documented |
| invalid responses | 10,000 401/403/429 per 10 minutes bans the IP | documented |

Every bot leaves through the one bridge netd, so the IP ban is shared. The bridge keeps
one fleet-wide invalid-response counter that trips a breaker far below the threshold
and names the bot that caused it. Each agent gets its own REST client with a global
token bucket and a bucket table learned from headers; the per-channel editor sits on
top and coalesces.

## Failure

| Failure | Detected by | The bridge |
|---|---|---|
| 429 | status, `retry_after` | waits it out, bounded; coalesced edits drop frames, never text |
| 400 on an edit | the error names the limit | rolls over; a refused rollover buffers the text for a plain post at the end |
| 403 or 404 on a card | the card was deleted or access was lost | stops editing it, buffers, posts plain at the end; if that fails too, logs and drops, and the answer remains in the agent's task store |
| the card's first post refused | status | the turn runs; its text is buffered for a plain post at the end, and a status change that needs the operator is still posted as a reply |
| an interaction acknowledgement refused | status | logged; the turn proceeds, and the client shows "didn't respond" on that tap |
| thread creation refused | status | refuses the turn with a reply saying so; a guild turn never runs outside a thread |
| agent unreachable | the card fetch fails | queues the message in state, replies "queued", retries every 30 s, as Slack |
| Stop on a finished task | no in-flight task for the thread | ephemeral "already finished" |
| bridge restart mid-turn | state holds each in-flight task with its card's message id, rendered text and steps | resubscribes to each task and keeps editing the same card from that record |
| Gateway drop | close, a missed heartbeat ack, op 7, or op 9 with `d: true` | resumes; REST edits continue meanwhile; dispatches missed during the gap replay on resume |
| resume refused | op 9 with `d: false`, close 4007 or 4009 | identifies fresh and logs the gap, which is messages lost |
| auth or intent error | close 4004, 4010 to 4014 | stops that agent's connection and reports it; a retry cannot help |

## Trust

- **The content intent is on.** Without it a bot sees content only in DMs, mentions and
  pinged replies, and the docs say attachments are stripped too; the operator saw an
  unmentioned image echoed as empty, though the recording cannot distinguish that from
  an empty message. Under 10,000 users it is a portal toggle. The bridge refuses to start
  without it, because the turn table is blind otherwise.
- **The loop guard.** A message whose author carries `bot: true`, or that carries a
  `webhook_id`, is never a turn, including the other agents' bots in a shared thread
  and the bridge's own interaction responses, which arrive with `webhook_id` equal to
  the application id. A message with no author is dropped. The allow-list above sits in
  front of all of it.
- **Attachments go through the bridge**, as on Slack. Agents' egress stays the tailnet;
  the bridge's egress carries the CDN hosts. A message attachment is recorded by id and
  served on demand from `/files/:id`, fetched through egress with the signed URL; a URL
  that has expired gets the message refetched for a fresh one, which is also how a
  queued turn's attachment survives the queue. A form upload is an "ephemeral
  attachment" Discord deletes on its own, so it is downloaded at receipt into the
  bridge's state directory, up to `max_attachment_bytes` in the bridge's config, whose
  default is the executor's exported `DEFAULT_MAX_ATTACHMENT_BYTES` so the two sides
  agree; a larger one is declined in-thread, and the recorded 205 MB form upload would
  be. Downloads and attachment records are pruned after thirty days, as the Slack
  bridge prunes its file records.
- **No public listener.** The Gateway is outbound; the toolbelt is tailnet-only behind
  the bridge's netd with peer tags stamped. Shape-only logging on every call.
- **Private app.** Public Bot off, so only the operator can install it, and the bridge
  ignores every server but the configured one, so an install elsewhere reaches nothing.

## The Gateway, under Bun

The Slack bridge's lesson holds: the bare `ws` specifier is Bun's built-in, which ignores
the proxy agent and dials straight out. The Gateway client is ours, over the aliased
package and the egress agent. Intents: `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`,
`MESSAGE_CONTENT`.

- **Heartbeat state is per connection.** A timer shared across connections beats on a
  dead socket, never sees an ack, and kills the live one; `tests/fixtures/discord/`
  holds the recording of that failure and of a session without it. The intent set above
  is the design; the spike identified with two more.
- **Resume.** READY carries a per-session regional resume host (`gateway-us-east1-c`,
  `-d`), which is why the allowlist carries `*.discord.gg`. Session id and resume URL
  are written to state on READY, and the sequence after each dispatch's handler returns,
  so a bridge restart resumes and receives what it missed or was mid-way through. Connect to RESUMED takes about 0.2 s
  through the tunnel; the supervisor's backoff is the rest.
- **Close codes.** Resume on 1006, on 4000 to 4003, 4005 and 4008, after op 7, and after
  op 9 with `d: true`; identify fresh on 4007, 4009, and op 9 with `d: false`; stop on
  4004 and 4010 to 4014. A client-initiated close uses a 4xxx code, because 1000 and 1001
  invalidate the session. Identifies are budgeted at 1,000 a day per bot and each one
  is logged.

## Provisioning

Once per agent, by hand, because the portal has no API for it: a New Application under
the Team, Public Bot off, Message Content on, Reset Token. The portal refuses a default
install link on a private application ("Private application cannot have a default
authorization link", seen in the portal), so the install URL is built by hand with the `bot` and
`applications.commands` scopes and the permissions the bridge uses:

| Permission | For |
|---|---|
| View Channels, Read Message History | seeing the conversation, and replay |
| Send Messages, Send Messages in Threads | answering |
| Create Public Threads | the thread a mention opens |
| Attach Files | uploads from the toolbelt |
| Add Reactions | the toolbelt's react |
| Change Nickname | the rendered identity |

```
https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=309304855616
```

The operator's own privacy setting on the server must allow DMs from members, or a DM
to the bot is refused by the client before it reaches the Gateway.

`discord.json`, mode 0600, is shaped like the Slack bridge's `slack.json`: the same
`agents_file`, `db_path`, `tailnet_domain`, `file_base_url`, `socket_path`,
`socket_group` and `egress_socket` keys, plus `guild_id`, `operators`, `test_bots`,
`max_attachment_bytes`, and per agent `application_id` and `bot_token`. It lives on the
bridge host, supplied to the unit through `LoadCredential`; the operator holds a token
only while minting it. The identity step, `thicket provision discord`, therefore runs on
the bridge host as the bridge's account, and renders from `agents.yaml` and the
`AgentCard` over REST with no browser step: the per-server nickname from the card's name
cut at 32 characters, the bio from its description cut at 190, the avatar from the
roster entry's `icon`, and `/new`. Nickname was
recorded; bio, avatar and the application description are documented and not yet
recorded. Commands per
skill come with forum channels: name slugged to `[-_a-z0-9]{1,32}`, description cut at
100, one string option carrying the request, and a turn so started carries
`thicket.trigger: discord-command`.

## The roster block

```yaml
discord:
  enabled: true
  channels:
    "999999999999991001": example   # channel id → workspace name
```

Strict and off by default, like `phone`. Keys are channel ids, never names: Discord
channel names are not unique across a server and a thread carries its own id, so the
parent lookup above is what resolves a binding. Capability only; tokens never enter the
roster.

## The toolbelt

The bridge serves the routes the Slack bridge serves, on its tailnet listener, scoped by
the calling agent's peer tag: `/files/:id`, `/api/messages`, `/api/files`,
`/api/reactions`, `/api/origin`, `/api/history`, `/api/replies`, `/api/search`,
`/api/channels`. agentd gains `discord_base_url` beside `slack_base_url` and offers a
second MCP server, `thicket-discord`, with `post_message`, `upload_file`, `react`,
`read_channel`, `read_thread`, `search_messages` and `list_channels`; the server name is
the prefix. There is no user listing: that needs the members privileged intent, and
people are named from the messages they wrote. The toolbelt and the routine store exist
when either base URL is configured, and the routine tools are offered once: in the Slack
server when there is one, otherwise in the Discord server. A routine's origin records
which surface it came from beside its coordinates, and its report goes back to that
surface. "This thread" resolves through
`/api/origin` from the context id, as on Slack. Whether a delegate's bot may post into a thread another
agent's bot opened is documented as allowed and not yet recorded; the spike had one bot.

## Milestones

- **M0, the spike.** The Gateway through egress, resume, the edit budget, the text
  limit, the form payload, the content-intent rules, multipart upload, threads, archive,
  nickname, presence, commands. Recordings in `tests/fixtures/discord/`.
- **M1, the round trip.** `apps/discord` with the Gateway client, the engine copied
  from Slack and reshaped around the turn table, state including the Gateway session,
  supervisor, heartbeat file. DM and mention-to-thread turns, the turn card with
  streaming, Stop, typing, rollover, the failure table. The egress test. The integration
  harness with a fake Discord and the recorded payloads as translate fixtures.
- **M2, the native features.** Questions as cards and forms, yes/no as buttons,
  attachments in and out through the file proxy, `/new`, the toolbelt and agentd's
  second base URL, the executor preamble, `thicket provision` for identity, a second
  app to record delegate posting.
- **M3, deployed.** System units and a netd pair, render support in the CLI, `doctor`
  probes, the live-testing harness mode and `discord-test-mcp`, forum channels and
  per-skill commands, custom status.

## External facts

Recorded on the wire by the M0 spike on 2026-10-05 and kept, with the fixture that shows
each one, in [reference.md](reference.md); `tests/fixtures/discord/` holds the redacted
recordings. The ones that shape the design:

- Free-form messages exist only on the Gateway; the HTTP interactions endpoint and
  webhook events never carry one (documented).
- `resume_gateway_url` is a per-session regional host under `discord.gg`, not the
  connect host (recorded).
- Edits, sends and typing are each a bucket of five refilling one per second per
  channel (recorded).
- Displayable text is 4,000 characters per Text Display and 4,000 per message across
  components; the error names which (recorded).
- A modal component with `min_values: 0` must also say `required: false`, or the modal
  is refused and the client shows "didn't respond in time" (recorded).
- Without the content intent: a DM, a mention and a pinged reply carry content; an
  unmentioned channel or thread message and an unpinged reply arrive empty (recorded);
  attachments are stripped too (documented, seen by the operator).
- A thread created from a message has the message's id; a post into an archived thread
  unarchives it (recorded).
- A DM to the bot is refused by the client while the operator's privacy setting on the
  shared server blocks DMs from members, and nothing reaches the Gateway (seen by the
  operator; an absence has no fixture).
- A form upload is an ephemeral attachment with a signed URL; one of 205 MB went
  through, so inbound size follows the uploader's account (recorded).

Sources: the Discord developer docs at `docs.discord.com/developers/`, chiefly
`events/gateway`, `components/reference`, `interactions/receiving-and-responding`,
`topics/rate-limits`, `topics/threads`, `resources/message`, and the change log entries
of 2025-04-22 (Components V2), 2026-02-12 (radio and checkbox components) and
2026-06-10 (privileged intents gated at 10,000 users).
