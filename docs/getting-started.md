# First useful run

Install Node 24 or newer, pnpm, Git, Claude Code, and Codex CLI. Log into the
provider CLIs yourself. ARC normally uses those CLI accounts.

```sh
cd /path/to/arc-executor
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node src/cli.ts doctor
```

The doctor reads installed CLI metadata and does not spend a model turn. It
does not establish that your account has capacity or that a model is available.

In the repository you want ARC to work on:

```sh
node /path/to/arc-executor/src/cli.ts init
```

Read the generated `arc.yaml`. For your first run set `landStrategy: none`:
ARC will leave verified work on its integration branch for inspection. Declare
your project's actual test and typecheck commands in `gates`. If a fresh
worktree needs dependencies, set `setupCommand` to your normal install command.
Leave `sandboxPolicy: refuse` in place.

```sh
node /path/to/arc-executor/src/cli.ts config
node /path/to/arc-executor/src/cli.ts "Add one small feature with tests"
```

The interactive flow investigates and produces a plan. Read the tasks, affected
files, proof commands, and delivery strategy before approving it. Start with one
or two tasks to establish that the repository's setup and gates work in fresh
worktrees. Expand to a larger mission after that succeeds.

For an existing plan:

```sh
arc validate plan.yaml
arc run plan.yaml --until-done
arc digest
```

Here and below, `arc` means the CLI above, installed through your usual alias or
link. See [configuration](configuration.md) and [unattended execution](unattended.md).

## Coming back to an incomplete run

```sh
arc digest
arc why TASK_ID
arc findings
arc ops
```

If an operation needs your action, perform it yourself and record what you did:

```sh
arc ops resolve OPERATION_ID --note "Created the test database and verified connectivity"
arc resume
```

Resolution records your statement. It never executes the operation description.
Use `--id ARC_ID` with `ops` to select an older run. Resume uses the stored plan;
editing a plan file does not rewrite its history or reset its attempt budget.

For a quarantined capability, correct the service or grant in `arc.yaml` and
resume. For a code failure, inspect the preserved task branch and receipts before
deciding whether to salvage it or start a revised mission. `arc clean --all` can
delete unmerged work; it is cleanup, not crash recovery.

## Choosing the lane

Use direct for small changes in your checkout, research for investigation,
review for checking existing changes, plan for design without implementation,
and deep for work that needs isolated tasks and crash recovery. A locked
`/lane deep` avoids an automatic route to direct for an important mission.

For multiple simultaneous missions, use deep lanes with distinct arc IDs.
Separate direct sessions still compete for the same checkout lock.
