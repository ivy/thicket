---
id: "002"
title: Roster schema and AgentCard generation
status: in-progress
component: packages/roster
language: typescript
depends_on: ["001"]
blocks: ["005", "006", "007", "008", "009", "010", "011"]
parallel_safe: true
---

# Roster schema and AgentCard generation

## Context

`agents.yaml` is the single source of truth for the fleet. This package defines its
schema and derives everything downstream from it. It is the shared contract: five other
tasks consume its types, so land it early and keep it stable.

## Scope

**Schema.** Define and validate `agents.yaml` with zod. One entry per agent:

```yaml
agents:
  hearth:
    host: home                  # logical host; resolves to a tailnet node name
    user: hearth                # unix account agentd runs as
    description: >-             # feeds AgentCard.description and Slack manifest
      Personal data: calendar, todo list, Obsidian vault, email triage.
    tag: tag:thicket-hearth     # tailnet ACL tag
    icon: ":herb:"              # Slack display only
    skills:
      - id: email-triage
        name: Email triage
        description: Reads and sorts the inbox, drafts replies.
        tags: [email, personal]
        examples:
          - "What needs a reply today?"
          - "Summarize anything from my landlord this week."
    harness:
      type: claude-agent-sdk
      cwd: /home/hearth
      model: claude-opus-5
      sessionTtlSeconds: 300
    context: native             # native | replay
    queueing: harness           # harness | bridge
```

`context` and `queueing` capture where harnesses differ. `native` means the agent
maintains its own conversation state keyed by `contextId`; `replay` means the bridge
must send thread history each turn. `harness` means the agent queues concurrent turns
itself; `bridge` means the bridge must serialize them.

**Card generation.** `toAgentCard(entry): AgentCard` producing a card valid against
`@a2a-js/sdk` types:

- `name`, `description`, `version`, `iconUrl`
- `supportedInterfaces[]` with the agent's tailnet URL and protocol binding
- `capabilities.streaming: true` for the Claude Agent SDK harness
- `skills[]` mapped from the roster entry
- `securitySchemes` / `securityRequirements` describing peer-tag authorization

**Path helpers.** XDG resolution used by every binary: `configDir()`, `stateDir()`,
`runtimeDir()`, and `socketPath(component)`. Honor `XDG_*` env vars with the documented
defaults; do not hardcode `~/.config`.

## Acceptance criteria

- [ ] A fixture `agents.yaml` covering four agents parses and produces four valid
      `AgentCard` objects.
- [ ] Invalid config fails with a message naming the offending path
      (e.g. `agents.hearth.skills[0].id`), not a bare zod dump.
- [ ] Duplicate agent names, duplicate tags, and duplicate `(host, user)` pairs are
      rejected.
- [ ] Round-trip test: generated cards parse back as `AgentCard` via the SDK's types.
- [ ] Path helpers respect `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR`
      when set, and fall back correctly when not.
- [ ] `context` and `queueing` default to `native` and `harness` when omitted.

## Out of scope

Serving the card over HTTP (task 008). Rendering Slack manifests (task 007).
