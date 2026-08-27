---
id: "033"
title: doctor's card check never gets the roster it needs
status: in-progress
component: apps/cli
language: typescript
depends_on: ["010"]
blocks: []
parallel_safe: true
---

# doctor's card check never gets the roster it needs

## Context

Observed during 029's live check: every `card` row fails with

```
FAIL [card] hearth: agent card not fetchable: agent missing from roster
```

because `bin.ts` builds the probes as `realProbes()` — no options — while
`realProbes` needs `roster` (and `tailnetDomain`) to resolve an agent's
URL. The doctor loads the roster two lines earlier and never hands it
over, so the card check has been structurally unable to succeed since it
was wired.

## Scope

- Pass the loaded roster (and the tailnet domain, once there is a place
  it comes from) into `realProbes` in `bin.ts`.
- A development host without a tailnet still needs a useful answer: the
  card URL is a tailnet name, so decide what the check should say when
  the URL cannot possibly resolve (likely "cannot check" rather than a
  fetch error).

## Acceptance criteria

- [ ] On a host where an agent's card is actually reachable, the card
      check passes.
- [ ] On the dev rig (unix socket, no tailnet), the card row explains
      itself instead of claiming the agent is missing from the roster.

## Out of scope

New checks; probe isolation (029 did that).
