# Sandbox capability gaps

> Design, 2026-08-30. Status: approved, not yet implemented.

## The problem

Arc failed a task it could never have completed, and only found out after
spending two implement attempts on it.

The task (`R01`: Postgres schema + RLS + pgTAP) is judged by a gate that needs
the Docker socket. The implementing agent runs in codex's `workspace-write`
sandbox, which blocks that socket. Arc's own gate runs are unsandboxed, so
*verification* worked — Arc could tell the agent its SQL was wrong. But the
agent could never run the SQL itself, so it was writing blind and each round
cost a full dispatch to learn one bit.

The generalisation, which is what this design is actually about:

> **An agent must be able to run the checks it will be graded by. Where it
> cannot, Arc must know before it spends anything.**

Nothing in Arc checks that today. Arc has a `ProviderCapability` concept, but it
is about *CLI flags* — does this binary support `--output-schema` — derived from
help text. Nothing anywhere probes what a **sandboxed writer can reach at
runtime**.

Two smaller defects fall out of the same hole:

- `RoleBinding.sandbox` is `read-only | workspace-write`. codex also accepts
  `danger-full-access`, so Arc cannot express a level the provider supports.
- `sandbox` is configured per **role**, not per **task**. Even with the enum
  widened, there is no way to say "this one task needs more" — it is all seven
  tasks or none.

### Verified on this machine, 2026-08-30

Everything below is reproducible, and the design rests on it:

```
docker info                                                    → exit 0
codex sandbox -c 'sandbox_mode="read-only"'          -- docker info → exit 1
codex sandbox -c 'sandbox_mode="workspace-write"'    -- docker info → exit 1
codex sandbox -c 'sandbox_mode="danger-full-access"' -- docker info → exit 0

codex sandbox -c 'sandbox_mode="read-only"'       -- sh -c 'touch ./x' → exit 1
codex sandbox -c 'sandbox_mode="workspace-write"' -- sh -c 'touch ./x' → exit 0

codex exec --help  →  --sandbox [possible values: read-only, workspace-write,
                                                  danger-full-access]
```

`codex sandbox` runs a command under the exact policy the writer gets, **with no
model call**. So the whole detection story costs subprocesses and zero tokens.

## Non-goals

- Replicating codex's sandbox ourselves. We drive `codex sandbox`; we do not
  reimplement Seatbelt.
- A mediated channel that lets a sandboxed agent ask Arc to run gates on its
  behalf. Considered and rejected for now — see Alternatives.
- Sandboxing the claude lane. F-2 stands: `sandbox` there is advisory, and this
  design reports that honestly rather than fixing it.
- Capabilities for the review or integrate roles. Reviewers are read-only and
  stay read-only.

## The capability model

A capability is a **name plus a probe**, both operator-authored:

```yaml
# arc.yaml
capabilities:
  docker:
    probe: docker info      # any command; exit 0 means "reachable"
    elevate: true           # may raise a task's sandbox to reach this
```

`elevate` defaults to `false`. **Defining a capability is not granting it.** You
can declare that `db:test` needs Docker and still have Arc refuse to widen
anything until you separately say so.

### The ladder is measured, not assumed

Arc carries **no table** of what needs which sandbox. For each capability it
runs the probe up the ladder — `read-only` → `workspace-write` →
`danger-full-access` → unsandboxed — and takes the **tightest level that
passes**.

Two definitions, so nothing below is readable two ways:

- **The role's level** is the `sandbox` configured on the `implement`
  `RoleBinding` for this arc. It is the floor; elevation only ever raises.
- **A task's level** is the loosest level required by any of its capabilities,
  or the role's level, whichever is looser. A task requiring nothing runs at the
  role's level, unchanged.

Probes run with `cwd` at the repo root, so a probe written the way a gate is
written behaves the same.

Consequences worth stating, because they are the reason for this shape:

- On a machine with a permissive Docker context, `docker` resolves to
  `workspace-write` and **no elevation happens at all**. The mechanism
  self-disables where it is not needed.
- When codex changes its sandbox policy, Arc's answer changes with it. Nothing
  to update.
- "You need to grant docker" and "you have not started Docker" become
  distinguishable, because the ladder includes an unsandboxed rung.

### Five outcomes

| Situation | Result |
|---|---|
| gate requires `x`, `arc.yaml` never defines `x` | **config validation error**, before anything runs |
| `x` unreachable even unsandboxed | tasks needing it **quarantined**: *"docker isn't reachable at all — is it running?"* |
| `x` needs elevation, `elevate: false` | **quarantined**, with the exact line to add |
| `x` needs elevation, `elevate: true` | **elevated**, logged, recorded |
| `x` already reachable at the role's level | nothing happens — no elevation, no noise |

## Declaration and derivation

A task's requirement is a union over the gates it will actually run, plus its
own explicit needs:

```
required(task) = ⋃ gate.requires  for selectGates(config.gates, task.gates)
               ∪ task.needs[].capability
```

```yaml
# arc.yaml
gates:
  - name: db:test
    command: npm run db:test
    proves: RLS denies cross-tenant reads
    requires: [docker]

# plan.yaml — the EXCEPTION, for a need that is not a gate's
tasks:
  - id: R01
    needs:
      - capability: docker
        because: iterating on RLS policies means running them
```

`because` is required and non-empty, the same way `touchesGateSurface` is: an
elevation with no stated reason is the thing that becomes invisible later.

The gate is the primary source because that is where the knowledge already is:
you wrote `npm run db:test`, so you know it needs Docker. A planner does not,
reliably, and it will forget — which puts you back at discovering the gap on
attempt two.

### The scoping consequence, surfaced not hidden

`gates: []` on a task means *all non-heavy gates*. So a docker-requiring gate
that is not scoped pulls every task up with it. That is arithmetically correct —
those tasks do run that gate — but rarely intended, so preflight says so
plainly:

```
! 7 of 7 tasks will run ELEVATED (docker) because gate "db:test" requires it.
  Scope the gate in the plan (task.gates) if that is not what you meant.
```

Which gates a task runs is a **work** decision and belongs to the planner. The
**boundary** decision remains exactly one operator line: `elevate: true`.

### Two keys, and no trust level collapses them

The planner may *request* (`needs:`); only `arc.yaml` *grants* (`elevate:
true`). `--danger` and `--until-done` do not grant. A model can ask for a wider
sandbox; it can never give itself one.

## The `quarantined` state

A task refused for a capability reason is **quarantined**, not failed:

- `computeFrontier` skips it, and it consumes no concurrency slot.
- It is not counted as a failure. It is reported in its own section with the
  reason and the remedy.
- The rest of the DAG runs to completion. In the motivating case R02–R07 finish
  while R01 waits for a decision, instead of the run limping.
- Dependents of a quarantined task remain blocked, by the existing rule that a
  dependency must have *landed*.
- The arc closes `incomplete` (exit 2). A quarantined task is not done.
- `arc resume` re-probes and re-evaluates: grant the capability, resume, and the
  task runs.

This is the state declined during v2 planning (`#66`) on the explicit grounds
that nothing produced the signal. This produces it.

## Runtime

**Probe timing.** Once at preflight, before any dispatch: at most four
subprocesses per capability — the three sandbox rungs plus unsandboxed —
taking milliseconds and zero tokens. Not cached across runs —
the machine changes and the probe is too cheap to be worth staleness.

**Recorded.** A `capability.probe` event carrying the full ladder result per
capability, and a `task.elevated` event naming the task, the capability and the
resolved level. Elevated tasks are named in the run log and in the final report
every time, never silently.

**`arc doctor`** grows a capability section. It already exists for provider-flag
capabilities and is the obvious home for "what can the writer actually reach".

**The backstop.** Declarations can be wrong, and Docker can die mid-run. When a
gate fails *and* its `requires` probe fails at that moment, Arc classifies it as
a capability loss rather than a code failure: no retry burned, no finding
blaming the writer, task quarantined with the real reason. This is what stops
the "burn both attempts on unexecuted SQL" outcome even when nobody declared
anything.

**The claude lane** gets an honest N/A. There is no OS sandbox there to probe or
widen, so a grant means nothing and elevation is a no-op. Only the unsandboxed
rung is probed, because the only question that still means anything is "is this
capability reachable on this machine at all" — a capability that fails there
still quarantines the task. Reported as N/A rather than implying parity.

## Components

| Unit | Responsibility |
|---|---|
| `src/capabilities.ts` (new) | The ladder. Probe one capability at one level via `codex sandbox`; resolve the tightest passing level; produce a typed result. No knowledge of tasks or plans. |
| `src/types.ts` | `capabilities` map and `requires` on `GateDef`; `needs` on `PlanTask`; `danger-full-access` added to the sandbox enum. |
| `src/scheduler.ts` | `validatePlan`: a `requires` naming an undefined capability is an error. `computeFrontier`: skip `quarantined`. |
| `src/orchestrator.ts` | Preflight probe; derive `required(task)`; resolve the sandbox for each dispatch; quarantine and report; the mid-run backstop. |
| `src/store.ts` | The `quarantined` state; `capability.probe` and `task.elevated` events. |

`capabilities.ts` is deliberately ignorant of Arc's domain — it answers "at which
level does this command succeed", nothing more, so it can be tested against real
`codex sandbox` behaviour without a plan, a store, or a repo.

## Testing

- **Unit** — ladder resolution (each of the five outcomes), the union
  derivation including the `gates: []` fan-out, and every refusal message.
- **Real probe** — one test that exercises `codex sandbox` for actual behaviour,
  skipped where codex is absent, guarded the way `sandboxUsable` already is.
- **Bench scenarios**, both adversarial in the existing sense:
  - a task requiring an ungranted capability is quarantined with **zero**
    dispatches, and its siblings still land;
  - a task requiring a granted capability runs elevated — asserted by
    `--sandbox danger-full-access` appearing in the recorded argv, which the
    transcript header already captures.
- **Regression** — a plan with no `capabilities` block behaves exactly as today.
  This feature must be invisible until someone declares a `requires`.

## Alternatives considered

**Mediated gate access.** The sandbox never widens; Arc drops a shim in the
worktree, the agent writes a request file, Arc runs the named gate outside the
sandbox and writes the result back. Strictly safer, and genuinely feasible over
the worktree filesystem, which `workspace-write` permits. Rejected for now on
size: it is a protocol, a watcher, and a security question about what the agent
may ask for, against a per-task grant that is small, visible, and enough. Worth
revisiting if elevation turns out to be requested often rather than rarely.

**A fixed `docker → danger-full-access` table.** Rejected: it would be wrong on
any machine whose Docker context is reachable from `workspace-write`, it would
rot when codex changes policy, and it could not distinguish "not granted" from
"not running".

**Task-declared only, no gate `requires`.** Rejected: it makes a model the
source of truth for a safety-relevant fact it does not reliably know.

**Detect and refuse, never elevate.** Rejected as the whole answer: it is the
right floor and is included, but on its own it leaves every task like `R01`
permanently outside what Arc can do.
