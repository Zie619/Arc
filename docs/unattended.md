# Running Arc unattended

Arc's defining capability is: start it, walk away, come back to work that is
either done and proved, or honestly reported as not done. This page is how.

---

## The short version

```bash
cd ~/your/repo
arc "make the importer handle duplicate rows"   # design + approve a plan
arc run plan.yaml --until-done                  # walk away
# ... later ...
arc digest                                      # what happened, and what needs you
```

`--until-done` supervises `arc run` and `arc resume` **only**. It is refused
anywhere else rather than silently doing nothing — the design phase asks you
questions, and a relaunch would restart the interview.

---

## What `--until-done` actually does

1. Spawns the run as a **child process**, under `caffeinate -dims` on macOS so
   the machine will not sleep through it.
2. Watches the child. If it dies while the arc is still `running`, it relaunches
   through `arc resume`.
3. Stops when the arc reaches a terminal status, or when relaunching is
   pointless.

**When it gives up.** Not on a flat count. It counts relaunches that produced
**no forward progress** — no new `land`, `attempt.end`, `task.state` or
`criterion.tier` event since the last one — and stops after three. A crash loop
and a laptop that slept four times overnight are different failures, and only
one of them is worth continuing through. Backoff is exponential from 15 seconds
to a ten-minute cap.

**What survives a crash.** Your work. A task caught mid-flight keeps its branch
and its commits; resume re-enters it rather than rebuilding from scratch. Every
budget — wall clock, attempts, the non-convergence history, capacity waits — is
derived from the database, so a resume continues one task instead of starting a
fresh one wearing the same name.

**What it cannot do.** Answer a question. See "Decisions it will hit" below.

---

## Knowing when you are needed

### Nothing to configure

Arc paints your terminal as it goes, over stderr, with no dependencies:

| Signal | When |
|---|---|
| Window/tab title — `arc · 4/9 · review` | every wave |
| Tab progress ring | continuously; **red** the moment a task fails |
| Toast + bell | needs-input, done, failed |

A failed run turns the tab ring red, which is readable from across the room
without focusing the window.

### A hook, when you want a phone to buzz

```yaml
# arc.yaml
notifyCommand: ["/Users/you/bin/arc-notify"]
```

The JSON event is appended as the final argument:

```json
{"kind":"failed","arcId":"importer","message":"INCOMPLETE — 2/4 landed","percent":100}
```

`kind` is one of `progress`, `needs-input`, `done`, `failed`. The command is
spawned detached with stdio null and a five-second timeout, and **a notifier
failure never fails the arc** — an arc must not die because a webhook was down.

A Slack one is three lines:

```bash
#!/bin/sh
# arc-notify — $1 is the JSON event
curl -sf -X POST -H 'Content-type: application/json' \
  --data "$(printf '{"text": %s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["message"]))')")" \
  "$SLACK_WEBHOOK_URL" >/dev/null
```

### Composition, which costs nothing

Arc exits `0` only when the arc is `done` **and** the work was actually
delivered — a rejected push or a failed `gh pr create` exits non-zero, because a
green build that never left your machine is not done.

```bash
arc run plan.yaml --until-done && arc digest | mail -s "arc: done" you@example.com
```

`arc digest` itself exits `3` when something is blocked on a human, so
`arc digest || page-me` works too.

---

## Coming back

```
arc digest                    # what happened, and what needs you
arc digest --since last-seen  # only what is new since you last looked
```

It reads in this order, and the order is the point:

1. **Needs you** — and only things genuinely blocked on a human. If nothing is,
   this block is absent and line one is the outcome. Its presence is the signal.
2. **The outcome** — landed/failed counts.
3. **Landed** — one line each. Success collapses.
4. **Failed** — expanded, with the first three lines of the real gate error and
   an `arc show <id>` for the rest. Every truncation names its escape hatch.
5. **Findings worth reading** — high and critical only.
6. **Handled without you** — capacity waits, relaunches, recovered workspaces.
   Interesting, not actionable. Hiding them would be dishonest; leading with
   them would be noise.

Other commands for a closer look:

```
arc status      where everything stands
arc criteria    every promise, and whether it is actually proven
arc findings    what the reviewer caught
arc cost        the token bill per role — and what went unmeasured
arc flaky       gates that gave different answers on the same commit
arc diff a b    two runs of the same plan, side by side
arc show <id>   the exact prompt, transcript or gate output of one step
```

---

## Decisions it will hit

An unattended run cannot ask you anything. Today it handles that by **failing
closed** on the decisions that matter:

| Situation | What happens |
|---|---|
| The project declares no gates | **Refused.** An arc with no gates cannot prove anything. Pass `--no-gates` to say you mean it. |
| A proof already passes at the base commit | **Refused before dispatching.** It cannot tell done from not-done. |
| A plan names a gate the config does not declare | **Refused before dispatching.** |
| A task declares no footprint or no contracts | **Refused.** Say `["."]` / `["none"]` and mean it. |
| The reviewer requires changes | One repair round, then the task fails. |
| A model substitute is served | Waits and retries if it is capacity weather; blocks if it is drift. |
| A blocking pending-op is raised | The arc completes what it can and reports INCOMPLETE. |

Everything refused above is refused **before anything is billed**.

---

## What it costs

Every ending prints the bill, and the numbers reconcile against a provider
dashboard: cache reads and writes are counted separately and priced separately,
the 5-minute and 1-hour cache TTLs are tracked apart, and reasoning tokens come
from the field the provider actually writes them to.

```
  implement  codex    3 attempt(s)   47min  in 1.20M (980K, 45% cached)  out  84K  reasoning 12K
  review     claude   8 attempt(s)   12min  in  115K (54K, 47% cached)   out 267   reasoning 249  $0.13
  ! 1 attempt(s) reported no usage receipt — every number above is a FLOOR.
```

The bounds you can set:

```yaml
maxAttempts: 4          # implement attempts per task — survives resume
maxTaskMinutes: 90      # wall clock per task — survives resume
maxRepairAttempts: 1    # a CHANGES_REQUIRED repair round is its OWN budget
maxRepairMinutes: 30
capacityWaitMinutes: 30 # how long to WAIT for the model you asked for
agentConcurrency: 3
```

Every one of these is derived from the database rather than from a stack frame,
so ten relaunches do not multiply them.

---

## The honest limits

- **`readOnly` is enforced by the OS on macOS and by a recorded caveat
  everywhere else.** Reviewer-authored check commands are model-authored shell
  that Arc executes on purpose, and only macOS Seatbelt applies the deny-write
  profile. Set `sandboxPolicy: refuse` to skip such checks entirely instead; the
  finding is then kept and marked unverified rather than silently dropped.
- **Seatbelt refuses to nest**, so the same is true when Arc itself runs inside
  a sandboxed agent session. Arc probes for this once and says so.
- **Contracts are an honour system.** Footprints are measured against the real
  diff; contracts are not. Two tasks that both fail to declare a shared contract
  can still land contradictory signatures.
- **A notifier is best-effort.** If it fails, you will not hear about the arc —
  check `arc digest` on a schedule if the run matters.
