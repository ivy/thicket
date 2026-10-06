# Discord recordings

Real traffic, recorded on the wire by the M0 spike (`spikes/discord/`) on 2026-10-05
against a private test server with one bot, every leg through the egress stand-in. The
human on every recording is the operator in the Discord client; the bot is the spike,
answering each human message with a reply that says how much content arrived.

One JSON object per line, in arrival order. `ms` is milliseconds since the spike
started, except on `rest` lines, where it is the call's duration. `kind` says what it is:

| `kind` | Holds |
|---|---|
| `dispatch` | a Gateway dispatch, its type under `t` and the payload verbatim under `d` |
| `rest` | a REST call: method, path, status, every `X-RateLimit-*` header, and the error body on a refusal; never the request or response body |
| `rest-429` | a refusal the spike waited out: `retryAfter` and the scope |
| `ws-connect`, `ws-open`, `ws-close`, `ws-send`, `hello`, `heartbeat-ack`, `ready` | the Gateway session: the host dialled, the resume host, close codes, every beat and its ack |
| `zombie` | the spike closing a socket whose last beat got no ack |
| `visibility` | per human message: mentioned, reply, content length, attachments, with and without the content intent |
| `gateway-bot`, `control`, `scenario` | the spike's own bookkeeping |

`spikes/discord/redact.ts` produced these from the raw recordings. Snowflakes are mapped
to stand-ins (`9999…1001` upward) consistently across every file, so a thread still has
its starter message's id and the same user is the same user everywhere. Usernames and
nicknames are `operator` and `thicket-dev`; avatars, banners and media placeholders are
null; the discriminator is `0000`; interaction tokens are `<interaction-token>`, in
bodies and in REST paths alike; signed CDN parameters are `<ex>`, `<is>`, `<hm>`;
filenames are `file.<ext>`. Dropped: the bot's own edit storm (`MESSAGE_UPDATE`), the
guild dump (`GUILD_CREATE`), member and thread-member updates, every typing event but
the first per file, the wall-clock stamp on each line, and from user objects their email,
roles, permissions and join dates. Message timestamps are real.

| File | What it shows |
|---|---|
| `gateway.jsonl` | one session with per-connection heartbeat state: identify, `ready` with a resume host that differs from the connect host, four minutes of beats and acks with no zombie, a socket terminated without a close frame (`1006`) and a client `4000` close each resumed on the regional host, then a fresh identify |
| `rest.jsonl` | the turn card, the question card, a multipart upload, a thread from a message (same id, and the 50 per 300 s bucket), nickname, command registration, typing, and two 3,000-character Text Displays refused: 4,000 per message |
| `stream.jsonl` | thirty-one edits of one card at one per second: the edit bucket's headers on every call and no refusal |
| `burst.jsonl` | edits as fast as the API allows: the bucket drains to zero, then every other edit is a 429 with `retry_after` |
| `limit.jsonl` | one Text Display grown by 1,000 until refused: 4,000 per component |
| `archive.jsonl` | a thread archived, then posted into: it unarchives |
| `interactions.jsonl` | two runs of the spike with the content intent. The first, with the shared-heartbeat bug that produced the 26 `zombie` lines: a mention, a plain channel message, a thread follow-up, an attachment with a mention, a select pick, Stop, and `/spike` deferred then edited; the DM the operator sent during it never arrived, see `docs/reference.md`. The second, short and zombie-free: a delivered DM, a pick, and an **Answer in full…** tap whose modal was refused for a required component with `min_values: 0` |
| `nocontent.jsonl` | without the content intent: a DM, a mention and a pinged reply carry content; a plain channel message, a thread follow-up and an unpinged reply arrive empty; then the full form flow, submit payload included |
