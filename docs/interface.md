# Using the ARC interface

ARC opens in a conversation. The banner identifies the repository and detected
checks; the footer identifies the thread, workflow, and approval mode. Those are
separate choices: `/lane` selects the kind of work, while Shift+Tab changes when
ARC asks for decisions. The footer explains the current mode before the first
request.

## Compose and navigate

| Key or command | Effect |
| --- | --- |
| Enter | Send a message, or queue it while work is active |
| Shift+Enter, Alt+Enter, or backslash then Enter | Insert a newline |
| Up / Down | Move through a multiline draft; recall history at its edges |
| Ctrl+A / Ctrl+E | Start / end of the current line |
| Ctrl+U / Ctrl+K / Ctrl+W | Delete to line start / end / previous word |
| `/` | Open the searchable command menu |
| Up / Down in the menu | Select a command; the visible window follows it |
| Tab in the menu | Complete the selected command |
| Escape in the menu | Close the menu without stopping work |
| Escape during work | Stop active agents and clear queued follow-ups |
| Ctrl+C during work | Arm exit; a second Ctrl+C stops the work and exits |

Long drafts wrap and show a small window around the cursor. ARC retains the
entire draft when you send it. Terminal scrollback retains completed exchanges;
opening a panel does not reprint the conversation.

`/queue` shows pending follow-ups. `/queue clear` removes them while leaving the
current mission running. Follow-ups wait while an input or inspection panel is
open. Switch threads after the active mission finishes or stops; `/steer <note>`
adds durable guidance to its next dispatch.

## Choose the work

`/lane` opens a picker with a description and the effect of each workflow.
Choose **deep** for isolated, resumable work; **direct** for a focused edit in the
current checkout; **research**, **review**, or **plan** for those specific outputs.
`/lane auto` returns routing to ARC.

`/model` opens role → model → effort selection. Escape moves back one step.
Custom model IDs and the typed `/model <role> <model> [effort]` form remain
available. Changes affect subsequent missions; an existing deep run retains its
frozen execution configuration.

If ARC starts above several repositories, the repository picker accepts a name
or path filter. Arrow keys choose among matches. An empty result cannot select
a repository by accident.

## Review a decision

Questions highlight the recommendation initially. Choose another option with
arrows or type your own answer. Enter confirms; Escape stops the request.

A deep plan approval screen shows its task count and goal, followed by a moving
task list. Up / Down selects a task. Its detail pane includes dependencies,
files, project gates, acceptance criteria, proof commands, and the specification.
Page Up / Page Down reveals the remaining details. The delivery description stays
visible above the approval keys. Enter or `y` approves the whole plan; `n` rejects
it; Escape cancels.

## Inspect a run

Open `/dashboard` from the conversation, or `arc ui` from another terminal.
`/dashboard RUN_ID` and `arc ui --id RUN_ID` open a specific saved run. A new run
appearing in the store does not change your selection.

| Key | Dashboard action |
| --- | --- |
| Up / Down or j / k | Select a task, in plan order |
| Enter | Open / close the selected task |
| Escape | Return from task detail; from the embedded dashboard, return to chat |
| Left / Right or [ / ] | Switch runs |
| Tab / Shift+Tab | Cycle Activity, Findings, Evidence, and Actions |
| Page Up / Page Down | Scroll the selected pane |
| f | Show only failed, blocked, or quarantined tasks; press again to show all |
| q | Close the dashboard; the mission continues |

The header puts blocking operations first. Task state uses both a symbol and a
label, so color is additional information. Evidence is compared with each
criterion's **required tier**; a waiver remains labeled. Zero criteria does not
mean every requirement was proved.

Task detail includes attempts, the latest stored transcript tail, acceptance
evidence, and recent checks. A running attempt's transcript becomes available
when the attempt ends. Long evidence lines wrap into the pane and can be paged;
`arc show ARTIFACT_ID` reads the complete saved artifact.

The dashboard fits the reported terminal height and responds to resizing.
`arc ui > snapshot.txt` emits a single noninteractive view.

## Resume with context

Use `/digest` for the outcome and outstanding work, `/findings` for reviews,
`/criteria` for proof state, and `/why TASK_ID` for a failure explanation. Local
inspection follows the current thread's latest run when it has one.

`/ops` lists pending operations. Perform an action yourself, then record it:

```text
/ops resolve OP_ID Started the database and checked connectivity
/resume RUN_ID
```

An operation ID may be an unambiguous prefix. Resolution requires a note and is
scoped to the inspected run. It never executes an agent's operation description.
`/resume` without an ID uses this thread's latest deep mission. It is refused
while another mission is active or the app is in plan-only mode. Completed runs
are left complete.

For a supervised continuation in another terminal:

```sh
arc resume --id RUN_ID --until-done
```

The explicit run ID takes precedence over a newer run or a local `plan.yaml`.
The supervisor retains that identity across relaunches.

## Preview without model calls

From the ARC checkout:

```sh
pnpm ui:preview
pnpm ui:preview --plan
```

These use an isolated temporary store and example mission data. They do not
start providers or edit a project. `pnpm docs:ui` renders the dashboard into the
README's SVG preview from the same components.
