# thicket runbook

Each entry: **symptom → diagnose → fix**. All commands run as the agent's own
account unless marked operator. `thicket fleet` is the first move for almost
everything: up/down per agent, in-flight tasks, last error.

## An agent stops responding in Slack

**Symptom.** Messages sit with no status change, or the session shows
`processing` forever.

**Diagnose.**

```sh
thicket fleet                                  # operator: is the agent up at all?
thicket doctor                                 # roster, tags, cards, apps, lingering
systemctl --user status thicket-agentd thicket-netd   # as the agent account
journalctl --user -u thicket-agentd -n 100     # structured JSON lines on stderr
```

- `fleet` says DOWN, netd unit dead → netd problem (next entries).
- `fleet` says up but Slack is silent → the bridge: check its account's
  `journalctl --user -u thicket-bridge`, look for `socket mode connection down`,
  `abandoning socket mode connection`, or `event handling failed`. On the
  bridge's host, `thicket doctor` reads the bridge's heartbeat file and says
  per agent whether the Socket Mode connection is up. A quietly dead socket
  is abandoned and rebuilt within about a minute on its own; each inbound
  event logs `ageMs`, so a message that sat out a dead window shows how
  long it waited.
- Task shows `working` in `fleet` for a long time → a genuinely long turn, or a
  wedged session (see below).

**Fix.** For a dead unit: `systemctl --user restart thicket-agentd` (netd needs
no restart, and vice versa). For a silent bridge: restart
`thicket-bridge.service`; queued messages are delivered from its SQLite queue
when agents become reachable.

## Socket Mode will not reconnect

**Symptom.** Bridge log shows repeated `socket mode connect failed` /
`socket mode connection down`; the app appears offline in Slack.

**Diagnose.**

```sh
journalctl --user -u thicket-bridge -n 50      # which agent's connection, what error
thicket doctor                                 # app installed? workspace at app cap?
```

- `invalid_auth` → the app-level token was revoked or regenerated.
- `ratelimited` at startup → too many rapid reconnects; the supervisor backs
  off automatically (1s → 60s), wait one minute.
- App uninstalled → doctor says so; reinstall via the printed authorize URL.

**Fix.** Rotate the app-level token in the app's settings, update the bridge
config (`~/.config/thicket/bridge.json`), restart the bridge. Connections are
per-agent: one bad token never takes other agents down.

## Tailnet auth key expired

**Symptom.** `thicket-netd` exits immediately at start; log shows
`joining tailnet:` or `auth key does not own tag ...`; `fleet` shows the agent
DOWN; `doctor` reports the node missing.

**Diagnose.**

```sh
journalctl --user -u thicket-netd -n 20
tailscale status | grep thicket-               # operator: is the node there?
```

**Fix.** Operator mints a fresh key **tagged with the agent's tag**
(`tag:thicket-<name>`), installs it at
`~/.config/thicket/tailnet-auth-key` (mode 0600) or sets `TS_AUTHKEY` in a
systemd drop-in, then `systemctl --user restart thicket-netd`. netd refuses to
start with a key that does not own the configured tag — that is deliberate;
fix the key, not the check.

## A session is wedged

**Symptom.** One thread never answers; other threads on the same agent work.
`fleet` may show an in-flight task that never finishes.

**Diagnose.**

```sh
thicket fleet                                  # in-flight count, last error
journalctl --user -u thicket-agentd -n 200 | grep <contextId>
```

The contextId is `uuidv5(channel_id:thread_ts)` — the bridge logs it on
mismatch, and every task carries it.

**Fix.** Press stop in Slack (issues a real `CancelTask`), or restart
`thicket-agentd`: the hot pool dies with the process, startup reconciliation
fails the orphaned tasks with a restart message, and the next message in the
thread cold-resumes the session from its transcript. History survives — the
session ID is derived, not stored.

## Tasks stuck in `working`

**Symptom.** `fleet` shows in-flight tasks that outlive any plausible turn;
clients poll `GetTask` forever.

**Diagnose.**

```sh
thicket fleet                                  # count per agent
journalctl --user -u thicket-agentd -n 100     # crash? "session stream failed"?
```

A task can only legitimately stay `working` while its subprocess turn runs.
If agentd crashed mid-turn, the next start fails them; if the subprocess died
mid-turn, the session manager injects a failure result. Stuck `working` with a
healthy daemon means the turn really is running (check `last-error` and the
agent's own logs).

**Fix.** `systemctl --user restart thicket-agentd` — reconciliation transitions
every `submitted`/`working` task to `failed` with an explanatory message, so
pollers terminate. If this recurs without crashes, capture the journal and the
task id before restarting; that is a bug worth a task file.

## Restarting the phone bridge drops live calls

The phone bridge holds one WebSocket per live call, and Twilio never
reconnects one: a restart ends every call in progress the way a dropped
signal would — the caller hears silence, then the line goes, and Twilio's
follow-up webhook records `failed:64105`. The session survives (the next
call is offered it back), a task that was running keeps running in agentd,
but the operator is cut off mid-sentence. So:

1. **Look before you restart.** `thicket doctor` on the phone host reports
   the heartbeat with the open-call count (`phone bridge heartbeat fresh,
   1 call open`); or read it directly:

   ```sh
   cat ~/.local/state/thicket/phone/health.json
   sqlite3 ~/.local/state/thicket/phone/phone.db 'select call_sid, agent, started_ms from calls where ended_ms is null'
   ```

2. **Wait for zero, or say so.** With a call open, wait for it to end, or
   warn the operator in #security-alerts first — they are the only caller.

3. **Restart netd only when you must.** The bridge restarts under its own
   unit without touching netd (`systemctl --user restart
   thicket-phone.service`); the node's tailnet identity, its certificate,
   and the Funnel listener stay up. Restarting netd drops the calls *and*
   makes the public hostname unreachable until the node rejoins, and the
   first ConversationRelay connect afterwards has been seen to fail with
   `64102` once before the next succeeds.

4. **Afterwards:** `thicket doctor` again — heartbeat fresh, public
   hostname answering, the number still pointed at the bridge.

## Live checks worth memorizing

```sh
thicket fleet                                   # fleet truth in one line per agent
thicket doctor                                  # config-level truth, non-zero on failure
curl --unix-socket "$XDG_RUNTIME_DIR/thicket/agentd.sock" \
     http://x/.well-known/agent-card.json       # is agentd itself alive (bypasses netd)
systemctl --user list-units 'thicket-*'         # what systemd thinks
```
