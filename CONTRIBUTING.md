# Contributing to arc

Thanks for wanting to help. Arc is small on purpose — four runtime
dependencies, one process, everything auditable — and it stays that way.

## Ground rules

1. **Every change lands with a test.** The suite runs against fake provider
   CLIs (`test/fixtures/`), so full flows are covered without spending a
   token. `pnpm test` must be green; `pnpm typecheck` must be clean.
2. **UI changes need a paint assertion.** Render through the fake terminal
   (`test/fake-terminal.ts`) and assert the visible frame. If you changed
   interaction, check it in a real terminal too — static reading of Ink code
   has repeatedly missed real bugs.
3. **Safety invariants are load-bearing.** Worktree isolation fails closed;
   the reviewer never sees the author's reasoning; a timed-out gate is a
   failed gate; agents never inherit the operator's environment; no
   fallback-model flags, ever. Weakening one requires a reproduced
   counterexample and a replacement test, not an argument.
4. **No new runtime dependencies** without an exceptional, stated reason.
   Dev dependencies are judged normally.
5. **Honest reporting.** "Landed", "reviewed", and "delivered" are different
   words. Code and copy that blur them get asked to stop.

## Getting set up

```bash
pnpm install
pnpm test        # ~15s, no network, no tokens
pnpm typecheck
```

To run the real thing you need the `claude` and `codex` CLIs installed and
logged in. `node src/cli.ts doctor` probes them without a model call.

## A nice way to contribute

Run Arc **on Arc**. Point it at this repo, give it a bug or a small feature,
and let it interview you, plan, build, and review. If the result is good,
open a PR and say it was self-built — failures and friction reports from
those runs are as valuable as the patches.

## Commit style

Lowercase `feat:`/`fix:` prefixes, subject as a sentence that says what
actually changed, body explaining *why* — ideally with the observed failure
that motivated it. Look at `git log` for the house voice.
