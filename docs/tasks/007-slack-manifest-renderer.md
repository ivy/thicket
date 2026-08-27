---
id: "007"
title: Slack app manifest renderer
status: todo
component: packages/slack-manifest
language: typescript
depends_on: ["002"]
blocks: ["010"]
parallel_safe: true
---

# Slack app manifest renderer

## Context

Each agent is its own Slack app so it gets a real agent surface — a mentionable bot
user, a DM, an agent container, and a top-nav entry. Slack's agent features are
app-scoped: agent sessions can only be created by "apps declared as agents in app
settings".

Manifests are generated from `AgentCard`, never hand-written, so the roster stays the
single source of truth. This package is a pure function; task 010 handles the API calls.

## Scope

`toSlackManifest(card, opts): SlackManifest` producing a v2 manifest.

**Field mapping.**

| Source | Manifest field |
|---|---|
| `card.name` | `display_information.name`, `features.bot_user.display_name` |
| `card.description` | `display_information.description`, `features.agent_view.agent_description` |
| `card.skills[].examples` | `features.agent_view.suggested_prompts[]` (`title`/`message`) |
| `card.skills[].name` | `features.agent_view.actions[]` |

**Fixed settings.**

- `settings.socket_mode_enabled: true`, and **no** `event_subscriptions.request_url` —
  Socket Mode replaces it.
- `settings.event_subscriptions.bot_events`: `assistant_thread_started`,
  `assistant_thread_context_changed`, `message.im`, `app_mention`,
  `agent_session_stopped`, `agent_session_title_changed`.
- `oauth_config.scopes.bot`: `assistant:write`, `chat:write`, `im:history`,
  `app_mentions:read`, `channels:history`.

**Constraints that will otherwise fail validation at runtime.**

- `display_information.long_description` has a **174-character minimum**. A terse card
  description will be rejected. Compose it from the description plus the skill list;
  fail loudly at render time rather than shipping a manifest the API refuses.
- `features.agent_view.agent_description` caps at **300 characters** — truncate on a
  word boundary.
- There is **no icon field** in the manifest schema. `display_information` carries only
  `name`, `description`, `long_description`, and `background_color`. Icons are uploaded
  by hand; emit a warning naming each agent whose `card.iconUrl` cannot be applied.
  (The `icon:` key in Slack CLI examples belongs to a different, hosted-app manifest
  schema — it does not apply here.)
- Emit `features.agent_view`, never `features.assistant_view`. New apps can only use
  `agent_view`, and migrating from `assistant_view` is irreversible.

## Acceptance criteria

- [ ] Golden-file tests: a fixture roster renders to checked-in expected manifests, and
      the test fails on any drift.
- [ ] A card whose composed `long_description` falls under 174 characters raises an
      error naming the agent — it does not silently pad or emit an invalid manifest.
- [ ] An `agent_description` over 300 characters is truncated on a word boundary.
- [ ] Rendered manifests contain no `assistant_view` key and no `request_url`.
- [ ] `socket_mode_enabled` is `true` in every rendered manifest.
- [ ] Agents with a `card.iconUrl` produce a warning listing the apps needing a manual
      icon upload.
- [ ] The function is pure: no network, no filesystem, no clock.

## Out of scope

Calling `apps.manifest.create` / `apps.manifest.update` (task 010). Uploading icons —
Slack has no API for it in this flow.
