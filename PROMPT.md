# Implementation loop

Implement thicket, one issue at a time, committing locally as you go.

This file is fed back to you verbatim at the start of every iteration. Context may be
compacted between iterations, so **re-orient from the repository and the issue tracker
every time — never from memory.** They are the state; your recollection is not.

---

## 1. Orient

- The board is the queue: https://github.com/users/ivy/projects/42 — only its **Ready** column.

  ```sh
  gh project item-list 42 --owner ivy --format json --jq '.items[] | select(.status == "Ready 🤖" or .status == "In Progress 🚧") | "\(.status)\t#\(.content.number)\t\(.milestone.title // "-")\t\(.assignees | join(","))\t\(.title)"'
  ```

  Milestones are arcs in order (`M0`, `M1`, …); the operator moves issues into Ready, never
  the loop. An issue that is open but not in Ready is not yours, however tempting.
- Read `docs/reference.md` — runtime topology, conventions, and verified external facts.
- If the issue sits in a phone milestone (`M0`–`M5`), read `docs/phone-bridge.md` — the
  design every phone issue assumes, and the vendor facts M0 is meant to verify.
- `git log --oneline -15`
- `git status`

## 2. Pick exactly one issue

In this order:

1. If any open issue is **assigned to you**, that is your issue — resume it. Do not
   start another.
2. Otherwise take the **Ready** item that is not labelled `blocked` and whose every
   `Depends on #N` is closed — lowest milestone first, then lowest issue number.
3. If Ready holds nothing you can take, go to **§8 Completion**.

Never work two issues in one iteration.

## 3. Claim it

```sh
gh issue edit NNN --add-assignee @me
item=$(gh project item-list 42 --owner ivy --format json --jq '.items[] | select(.content.number == NNN) | .id')
gh project item-edit --project-id PVT_kwHOADgWUM4Bh47V --id "$item" \
  --field-id PVTSSF_lAHOADgWUM4Bh47Vzhgy8nY --single-select-option-id dacd8d8c   # In Progress 🚧
```

The assignment is the claim, and it is durable — if the iteration dies, the next one
resumes rather than restarts. Say in a comment what you are starting on if the issue has
been sitting a while.

## 4. Implement

- **Scope is the issue's `## Scope` section. Nothing else.** Do not build ahead, do not
  refactor neighbouring code, do not add features the issue did not ask for.
- Work through the `## Acceptance criteria` list. **Check off each `- [ ]` in the issue
  body as you verify it** — that checklist is your progress across iterations, and it is
  visible to the operator without reading the diff:

  ```sh
  gh issue view NNN --json body -q .body > /tmp/body.md
  # edit the one box you verified, then:
  gh issue edit NNN --body-file /tmp/body.md
  ```

- Some boxes can only be observed by a person — placing a call, tapping a button,
  listening to what was said. Do everything else first, commit it, then treat that box
  as §6: say precisely what the operator should do and what they should see.
- Only check a box when you have actually observed the behaviour. A passing test you
  ran, output you read. Not "this should work." Say in the box what you observed, the
  way the existing criteria do.
- Run whatever checks the repo has: `pnpm build`, `pnpm test`, `pnpm lint`,
  `go build ./netd/...`, `go test ./netd/...`.
- The issue's `## References` and `## Out of scope` sections are binding. `Out of scope`
  means another issue owns it.

## 5. Land it

Only when **every** acceptance criterion is checked and the repo's checks pass:

- Commit with a conventional-commit subject and a body explaining *why*, closing the
  issue:

```
feat(roster): derive AgentCards from agents.yaml

Downstream components need one source of truth for agent identity and
capability so manifests, cards, and per-account config cannot drift.

Closes #8.
```

`Closes #N` on a commit that reaches `main` closes the issue for you. If the work landed
without that trailer, close it by hand with a comment saying what shipped. A closed issue
moves itself to **Done ✅** on the board; if it has not within a minute, set it:
`--single-select-option-id 8ee47ba7`.

- Commit locally as you go. **Pushing `main` to `origin` is allowed when an acceptance
  criterion needs it** — CI observed on GitHub — and only then; push what is landed,
  never force, never open a PR, never change a remote.

Then stop and let the loop hand you the next issue.

**If you cannot finish this iteration** (context running out, a long test cycle, a hard
problem): leave the issue assigned to you, commit the partial work with a `wip:` subject
describing exactly where you stopped, and stop. The next iteration picks it up.

## 6. Blocked

Only for a genuine external blocker — a missing credential, an upstream API that behaves
differently than the issue assumes, a decision only the operator can make. **Difficulty
is not a blocker.** Try properly first.

- `gh issue edit NNN --add-label blocked`, and move the board item back to **Planning 🧠**
  (`--single-select-option-id 6d145703`) so Ready stays an honest queue
- Append a `## Blocked` section to the issue body stating precisely what is needed to
  unblock it, what you already tried, and which criteria you finished anyway.
- Unassign yourself so the next iteration does not resume it.
- Commit whatever landed, then stop. The next iteration moves to another issue.

The `blocked` label means **the operator must act**. Use it for nothing else.

## 7. Backlog expansion

You may create new issues. When implementation surfaces follow-on work, a blocker that
deserves its own work item, or a spec assumption that turns out wrong in practice:

**Bugs and gaps you merely notice en route** — a tool that crashes, a check that lies, a
doc that misleads — are backlog, not scope creep. File an issue for each instead of
fixing it inside the current one.

```sh
gh issue create --title "..." --body-file /tmp/issue.md
```

- Write it in the style of the existing issues: problem statement, why it matters,
  Scope, Acceptance criteria as `- [ ]` boxes, Out of scope, and `Depends on #N` where
  a real dependency exists.
- Label `blocked` only when something genuinely external is needed, and write that
  rationale into the body.
- Commit the work that surfaced it and mention the new issue number in the body.

Expanding the backlog when reality disagrees with the plan is welcome; silently building
unplanned scope inside an unrelated issue is not. New issues are picked up by the normal
selection rule in §2.

## 8. Completion

When the Ready column is empty, or everything in it is labelled `blocked` or waiting on an
open dependency:

- Summarize what closed this run and what is blocked, with the reason for each blocker.
- Then output exactly:

```
<promise>ALL TASKS COMPLETE</promise>
```

Output that promise **only** when it is unequivocally true. Do not output it because you
are stuck, tired of the loop, or think you should stop. If the loop should end, it will
end on its own terms.

---

## Guard rails

- One issue per iteration. No exceptions.
- Never close an issue with an unchecked acceptance criterion.
- Never check a criterion you have not verified by observation.
- Never remove the `blocked` label — only the operator clears a blocker.
- Push only `main` to `origin`, only when a criterion needs it. Never force-push, never
  open a PR, never modify git remotes.
- Never commit `.claude/ralph-loop.local.md`, `.env`, or any credential file.
- Never edit `PROMPT.md`.
- If an issue's specification turns out to be **wrong** — an API does not work as it
  claims, an acceptance criterion is impossible — edit the issue body, explain the change
  in a comment, and continue. Do not silently build something different from what the
  issue says.
- If you find yourself repeating an approach that already failed, stop and reconsider
  rather than trying it again harder. Read the git log and the issue's comments; you may
  have already tried it in an earlier iteration.
