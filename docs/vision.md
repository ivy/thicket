# Vision

## The goal

An agent on every system I operate — reachable wherever I am, responsive to events I
never see.

I work across a laptop and a home server with several unix accounts. Each of those
contexts has standing work — patching and health monitoring, building services,
dependency maintenance, media management, personal data in a calendar and an Obsidian
vault, an email inbox. Today that work either happens by hand or happens in a Claude
Code session I have to be sitting in front of.

thicket makes each of those contexts a persistent, addressable agent. I reach it from
Slack on my phone or from Claude Code on my laptop, and it is the same agent with the
same memory either way. Agents reach each other directly when a task spans contexts.

Little of that standing work begins with me typing. It begins when a dependency bot
opens a PR, when an exception tracker files a new issue, when a charge posts, when next
week's calendar firms up. An agent answers three kinds of trigger — a person on a human
surface, the clock, and an event from the world — and a context is only covered when
all three can reach it.

## Core principles

### Add an agent when you need a new blast radius, not a new skill

"Apply security patches as root" and "triage my inbox" do not need different
personalities. They need different privileges. `CLAUDE.md` and skills cannot enforce a
blast radius; a unix account can.

An agent's identity is therefore a `(host, unix user)` pair, and the roster grows when a
new trust boundary is needed — not when a new capability is. Specialization within a
boundary comes from skills, `CLAUDE.md`, and the tools installed in that account.

This also means the number of agents stays proportional to the number of accounts rather
than to the cross product of capabilities and machines.

### Untrusted ingest never reaches privilege

Agents that read email, fetch torrents, or browse the web process attacker-controlled
text. Agents that hold root do not read that text. These are separate unix accounts on
separate tailnet nodes, and the ACL permits privilege-holding agents to call
ingest agents but not the reverse.

A prompt injection that tries to hop toward root fails at the network layer, not at a
prompt boundary.

The same rule shapes event pipelines that end in privilege. A dependency bump that ends
in a merge is fed by attacker-influenced text — diffs, changelogs, commit messages —
aimed at the very agent reviewing it. That agent is ingest-class and its output is a
verdict artifact; between the verdict and the privileged act sit deterministic gates —
checksums, CI, provenance — that no model output can waive. The guard that reads the
poison never holds the keys.

### A2A is the only transport between agents

Slack is a human surface. Agents never coordinate by posting messages at each other:
that invites mention loops, burns the per-app event budget, and cannot carry task state.

Agent-to-agent work goes over A2A, which carries `contextId`, `taskId`, and artifacts.
When an agent is working inside a Slack thread it passes the thread's coordinates in
`Task.metadata`, so a delegate can post its own progress into that thread under its own
identity. The human sees one conversation; the coordination never touches Slack.

### Bridges are adapters, and there will be many

A bridge does one job: translate a foreign vocabulary — Slack events, GitHub webhooks,
Sentry alerts — into `message/send` on the right agent, and carry task events back to
whatever needs them. Slack is the first bridge, not a privileged one; most of what its
surface demands is presentation, not protocol.

Machine events never ride through the human surface. An exception tracker posting into
a channel is a notification for me, not an ingress for the fleet — chat as a shared bus
invites exactly the mention loops and lost task state that A2A exists to avoid.

Bridges hold no policy. When one event fans out into a pipeline — review, then
refactor, then merge — that pipeline is an agent's job, delegated over A2A, because
judgment lives where skills and `CLAUDE.md` do. A bridge that holds a workflow
definition has become a workflow engine; those exist, and thicket is not one.

### Capability is advertised, not encoded in identity

Naming agents after accounts would make the roster describe infrastructure rather than
intent. A2A already separates these: `AgentCard.name` is identity, `skills[]` is
capability.

Agents are discovered and routed by skill. The Slack surface each agent presents —
its description and suggested prompts — is generated from its skills, so a
system-oriented identity yields a capability-oriented UI.

### Generate at deploy time; discover at run time

Slack app manifests, per-account configuration, and tailnet identities are rendered from
`agents.yaml` by the provisioning CLI. `agents.yaml` in git is the source of truth, and
every generated artifact is reproducible from it.

At run time there is no shared configuration file. Each agent serves its own
`AgentCard` at `/.well-known/agent-card.json` and clients discover capability by
fetching cards. An agent can change its skills and the fleet picks it up on the next
fetch, with nothing else redeployed.

### The agent runtime never touches the network

`agentd` binds a unix socket and nothing else. A small Go process holds the tailnet
identity, terminates TLS, verifies the calling peer, and proxies inward.

Authorization inside `agentd` is a header read, not an auth implementation. There are no
per-agent secrets to distribute or rotate for agent-to-agent calls.

### Any harness, behind the same contract

The Claude Agent SDK is the first harness, not the only one. Anything that can serve an
`AgentCard` and answer `SendMessage` joins the fleet — a different model, a bespoke
service, someone else's agent.

Where harnesses differ in behavior, the difference is a per-agent config flag rather
than a fork in the bridge: whether the agent maintains its own context by `contextId`
or needs thread history replayed, and whether it queues concurrent turns or needs the
bridge to serialize them.

## Non-goals

- **Multi-tenancy.** One operator, one Slack workspace, one tailnet. Nothing here
  needs to serve other organizations, and no design decision should be paid for twice
  to keep that door open.
- **Marketplace distribution.** These are internal Slack apps. Socket Mode is used
  deliberately, and Socket Mode apps cannot be listed in the Slack Marketplace.
- **Replacing Claude Code.** Local interactive work stays local and interactive.
  thicket makes those sessions reachable when I am not at the keyboard.
- **A general agent platform.** Scope is one operator's systems and standing work —
  including the external services that work runs against: a repo host, an exception
  tracker, a bank, a subscription box. Features that only pay off at fleet sizes I
  will never reach are out.
