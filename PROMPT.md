# Implementation loop

Implement thicket, one task at a time, committing locally as you go.

This file is fed back to you verbatim at the start of every iteration. Context may be
compacted between iterations, so **re-orient from the repository every time — never from
memory.** The repository is the state; your recollection is not.

---

## 1. Orient

- Read `docs/tasks/000-overview.md`.
- Read the YAML frontmatter of every `docs/tasks/NNN-*.md`.
- `git log --oneline -15`
- `git status`

## 2. Pick exactly one task

In this order:

1. If any task has `status: in-progress`, **that is your task** — resume it. Do not
   start another.
2. Otherwise take the lowest-numbered task with `status: todo` whose every entry in
   `depends_on` has `status: done`.
3. If neither exists, go to **§6 Completion**.

Never work two tasks in one iteration.

## 3. Claim it

Set `status: in-progress` in that task's frontmatter and commit only that change:

```
chore(tasks): start NNN <short title>
```

This makes the claim durable — if the iteration dies, the next one resumes rather than
restarts.

## 4. Implement

- **Scope is the task's `## Scope` section. Nothing else.** Do not build ahead, do not
  refactor neighbouring code, do not add features the task did not ask for.
- Respect ownership: the `component:` field says which path this task owns. Do not edit
  files belonging to a task that is not yours. If two tasks share a directory, see
  "Shared components" in `000-overview.md`.
- Work through the `## Acceptance criteria` list. **Check off each `- [ ]` in the task
  file as you verify it**, and commit those check-offs as you go — that checklist is
  your progress across iterations.
- Only check a box when you have actually observed the behavior. A passing test you ran,
  output you read. Not "this should work."
- Run whatever checks the repo has: `pnpm build`, `pnpm test`, `pnpm lint`,
  `go build ./netd/...`, `go test ./netd/...`. Before task 001 lands, some of these will
  not exist — that is expected, not a failure.
- The task's `## References` and `## Out of scope` sections are binding. `Out of scope`
  means another task owns it.

## 5. Land it

Only when **every** acceptance criterion is checked and the repo's checks pass:

- Set `status: done` in the frontmatter.
- Commit with a conventional-commit subject and a body explaining *why*, referencing the
  task:

```
feat(roster): derive AgentCards from agents.yaml

Downstream components need one source of truth for agent identity and
capability so manifests, cards, and per-account config cannot drift.

Task 002.
```

- **Local commits only. Never `git push`. Never open a PR. Never touch a remote.**

Then stop and let the loop hand you the next task.

**If you cannot finish this iteration** (context running out, a long test cycle, a hard
problem): leave `status: in-progress`, commit the partial work with a `wip:` subject
describing exactly where you stopped, and stop. The next iteration picks it up.

## 6. Blocked

Only for a genuine external blocker — a missing credential, an upstream API that behaves
differently than the task assumes, a decision only the operator can make. **Difficulty is
not a blocker.** Try properly first.

- Set `status: blocked`.
- Append a `## Blocked` section to the task file stating precisely what is needed to
  unblock it and what you already tried.
- Commit, then stop. The next iteration moves to another task.

## 7. Completion

When no task has `status: todo` or `status: in-progress`:

- Summarize what is `done` and what is `blocked`, with the reason for each blocker.
- Then output exactly:

```
<promise>ALL TASKS COMPLETE</promise>
```

Output that promise **only** when it is unequivocally true — every task is `done` or
`blocked` with a written reason. Do not output it because you are stuck, tired of the
loop, or think you should stop. If the loop should end, it will end on its own terms.

---

## Guard rails

- One task per iteration. No exceptions.
- Never mark a task `done` with an unchecked acceptance criterion.
- Never check a criterion you have not verified by observation.
- Never push, never open a PR, never modify git remotes.
- Never commit `.claude/ralph-loop.local.md` — add `.claude/*.local.*` to `.gitignore`
  as part of task 001.
- Never edit `PROMPT.md`.
- If a task's specification turns out to be **wrong** — an API does not work as the task
  claims, an acceptance criterion is impossible — fix the task file, explain the change
  in the commit body, and continue. Do not silently build something different from what
  the task says.
- If you find yourself repeating an approach that already failed, stop and reconsider
  rather than trying it again harder. Read the git log for this task; you may have
  already tried it in an earlier iteration.
