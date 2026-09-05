<p align="center">
  <img src="docs/assets/hero.jpg" alt="arc" width="100%" />
</p>

<h1 align="center">arc</h1>

<p align="center"><b>A terminal orchestrator for AI coding agents.<br/>Models think. The program remembers.</b></p>

<p align="center">
  <a href="https://github.com/Zie619/Arc/actions/workflows/ci.yml"><img src="https://github.com/Zie619/Arc/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-MIT-a78bfa" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-22d3ee" alt="node >= 24" />
  <img src="https://img.shields.io/badge/runtime%20deps-4-34d399" alt="4 runtime deps" />
  <img src="https://img.shields.io/badge/status-alpha-e879f9" alt="alpha" />
</p>

<p align="center">
  <img src="docs/assets/demo.svg" alt="arc demo" width="760" />
</p>

---

ARC runs a coding mission across multiple agents and keeps the goal, work, and
proof outside their conversations. One model investigates and plans, another
implements in isolated Git worktrees, and an independent model reviews. Your
project's actual checks run before work is accepted.

The original need was simple: **give it a large request, walk away, and come back
knowing what changed, what passed, and what still needs you.** Long conversations,
mixed-up checkouts, repeated infrastructure failures, and unsupported “done”
claims drove the design. [Why we built ARC →](docs/purpose.md)

## Start here

Use Node 24 or newer, pnpm, Git, and logged-in `claude` and `codex` CLIs.

```sh
git clone https://github.com/Zie619/Arc.git
cd Arc
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node src/cli.ts doctor
```

Then open it in the repository you want to work on:

```sh
cd ~/your/project
node /path/to/Arc/src/cli.ts
```

For a first mission, run `arc init`, inspect the detected gates, set
`landStrategy: none`, and start with a small task. You can inspect the resulting
integration branch before choosing how to deliver it.

**[First-run guide](docs/getting-started.md)** ·
[Configuration](docs/configuration.md) ·
[Unattended execution](docs/unattended.md) ·
[Security model](docs/security.md)

## How a deep mission works

1. Clarify the goal and the decisions that change the work.
2. Send read-only scouts to check the repository and the brief's assumptions.
3. Produce a plan with dependencies, file footprints, shared contracts, and acceptance checks.
4. Run eligible tasks concurrently in separate worktrees. Fill free slots as tasks finish.
5. Execute checks and independent review, then serialize rebasing and landing on an integration branch.
6. Re-run project gates and landed tasks' command criteria on the combined tree, review integration, and deliver using the configured strategy.

SQLite and immutable artifacts hold the charter, attempts, findings, and evidence.
Every dispatch gets a fresh brief. Resume claims ownership before recovering
stranded tasks and retains committed work and spent budgets.

## Choose the right lane

| Lane | Use it for |
| --- | --- |
| direct | A small change in the current checkout, with a checkpoint, gates, and review |
| research | Read-only investigation and synthesis |
| plan | Design and a proposed plan without building |
| review | Review existing changes |
| deep | Isolated tasks, concurrency, durable evidence, and crash recovery |

Pin a lane with `/lane deep` or return to automatic routing with `/lane auto`.
Use `/model` to configure provider, model, and effort per role. ARC drives
provider CLIs; it does not silently substitute a fallback model.

## Leave it running; return to receipts

```sh
arc run plan.yaml --until-done
arc digest
arc why TASK_ID
arc criteria
arc findings
arc ops
```

The supervisor prevents sleep on macOS and relaunches crashed runs through
resume. Repeated crashes without progress stop. A blocking operation pauses new
work; complete the action, record it with
`arc ops resolve OP_ID --note "what you did"`, then `arc resume`.

A failed task keeps its worktree for inspection. Successfully landed task
worktrees are removed. A failed push or PR creation leaves the run incomplete.

## Safety and limits

- **Trusted repositories only.** Worktrees share Git metadata. Project dependencies,
  hooks, provider settings, and approved commands can execute code as your user.
- **Read-only reproduction commands fail closed by default.** macOS checks have
  private scratch space and denied writes outside it, plus denied network access.
  Where the OS sandbox is unavailable, the finding stays unverified and the command
  is skipped. `sandboxPolicy: caveat` explicitly permits an unsandboxed check.
- **Provider isolation differs.** Codex uses its sandbox controls. Claude agents use
  tool permissions and a minimized environment; ARC does not give them an OS sandbox.
- **Evidence belongs to a revision.** New implementation attempts invalidate old
  criteria. Final checks must hold on the combined tree. Independent review can
  still miss bugs.
- **Alpha.** The deterministic tests and adversarial benchmark verify harness
  behavior with fake providers. They do not measure coding-model quality or prove
  universal reliability. Direct edits do not have deep-run crash recovery.

Read the [security model](docs/security.md) for the trust boundaries and explicit
capability grants. ARC also supports bounded retries, model identity checks,
TypeScript contract scanning, token receipts, and command evidence.

## Development

```sh
pnpm typecheck
pnpm test
pnpm bench
pnpm docs:check
```

Tests and benchmarks use fake provider CLIs and spend no model tokens. No new
runtime dependencies were added for the execution hardening.
See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
