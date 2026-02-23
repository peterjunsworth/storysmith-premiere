# Project Instructions

Subdirectory CLAUDE.md files take precedence over this file.

## Ask Before Implementing

Clarify before writing code. Use `AskUserQuestion` with 2–4 options for decisions. Never assume approach, pattern, or scope.

## Read → Plan → Implement

1. **Read** every file to be modified (`Read` tool). Use `Explore` subagent for codebase questions.
2. **Plan** — write plan to progress file (see Progress). Use `EnterPlanMode` for > 2 files or architectural decisions.
3. **Approve** — present plan, wait for approval, then implement.

## Subagents

Delegate all long-running, parallel, or multi-step work via `Task` tool.

| Type | Use for |
|------|---------|
| `Explore` | Codebase structure, search, patterns |
| `Plan` | Architecture, strategy |
| `Bash` | Git, terminal, process ops |
| `general-purpose` | Research, web lookups |

**Rules:**
- Prompt must be self-contained (no shared memory with parent)
- State expected output format explicitly
- Launch independent agents in parallel (single message, multiple `Task` calls)

**Prompt template:**
```
Context: [current state / what we're building]
Task: [what to do]
Constraints: [must not break X / follow pattern Y]
Output: [file path / JSON / summary]
Related files: [src/foo.ts]
```

## Large Work → Parts

Split when: **> 900 lines output**, **> 5 files**, or **multiple sequential phases**.

- Define all parts upfront before starting Part 1
- Name: `Part 1 — Schema`, `Part 2 — Service`, `Part 3 — Tests`
- Verify each part before starting the next
- Update progress file after each part

## Progress Tracking

Every task needs a progress file:

```
./context/{area}/progress/{task-slug}.md
```

Areas: `api` · `ui` · `cli` · `infra` · `db` · `test` · `research`

```markdown
# Progress: {Task Name}
## Status
- [ ] Part 1 — description
- [ ] Part 2 — description
## Log
### Part 1
- Files: [list]
- Notes: [unexpected findings]
```

Update: on start (create), after each part (check off + log), on completion, on interruption.

## Scripts & Files

| Purpose | Path |
|---------|------|
| Temp utilities | `scripts/tmp/{slug}-{tool}.{ext}` |
| Task scripts | `development/{task-slug}/script/{slug}-{tool}.{ext}` |
| Research | `research/{slug}/` |

Delete `scripts/tmp/` after verification.

## Code

- Read before modify — never change unread files
- Minimal changes — no opportunistic refactors
- Delete unused code — no `_old` stubs or compat shims
- No over-engineering — 3 similar lines > premature abstraction
- No hardcoded secrets, no SQL/XSS/command injection

## Web Research

Never use `WebSearch`. Use `google-search` MCP:
```
search(query, num=8) → pick top URLs → sub-agent: read_webpage(url)
```
