# Security model

ARC assumes you trust the repository, its dependencies, and the commands you
approve in its configuration and plan. Use a disposable VM or equivalent
isolation for hostile code. A worktree separates working files; it shares Git
metadata and is not a tenant boundary.

## Execution boundaries

| Boundary | Enforcement | Limit |
| --- | --- | --- |
| Task working files | Separate Git worktree; provision fails closed | Linked worktrees share the repository's Git directory |
| Direct checkout edits | Cross-process checkout lock and before/after snapshot | External editors and tools do not participate in ARC's lock |
| Run ownership | Conditional SQLite lease claim before recovery; release in `finally` | Local state should live on a local filesystem; distributed execution is unsupported |
| Codex writer | Provider sandbox policy, with declared capability elevation | Granting full access widens the whole process; it is not a scoped Docker permission |
| Claude agent | Tool permissions and a minimized environment | ARC does not apply an OS sandbox to this provider's agent process |
| Reviewer reproduction command | macOS deny-write profile, private scratch, network denied | Reads remain available; this is not filesystem secrecy or a malicious-process containment boundary |
| Missing command sandbox | Default `sandboxPolicy: refuse` | Findings remain unverified; no reproduction verdict is invented |
| Approved setup, refresh, gates, and task proof commands | Time limits, deliberate environment, recorded results | Ordinary commands run with the operator's OS permissions |
| Provider environment | Runtime basics, the selected provider's authentication, explicit role variables | HOME and provider config remain available for login; this is not credential isolation from malicious code |

Read-only reproduction commands may write only to their dedicated temporary
directory and `/dev/null`. Other temporary worktrees are not writable. The
scratch directory is removed when the check ends. Cancellation does not launch an
already-cancelled command, and ARC kills the command process group on termination.

On Linux, or when macOS Seatbelt cannot be applied (including some nested sandbox
environments), the default keeps the finding and skips its shell command. The
operator can explicitly set `sandboxPolicy: caveat` to permit an unsandboxed
check. That is a security tradeoff, and ARC records it as such.

SSH agent access is excluded from default provider, gate, probe, and contract
compiler environments. A role or gate can explicitly request `SSH_AUTH_SOCK`
through `envAllowlist`. Delivery remains an operator-authorized Git operation.

## Who may grant authority

The plan may request a capability. The project configuration grants elevation.
`--danger` and unattended execution do not grant capabilities. A resume keeps the
original execution configuration and plan but reloads capability definitions and
grants from the operator's current configuration, then probes again. Completed
tasks are not re-quarantined.

Treat `arc.yaml`, project provider settings, MCP configuration, dependency
installation, hooks, and approved plan commands as executable configuration.
Reviewing a generated command for portability does not prove it safe.

## Evidence rules

- An agent claim alone cannot grant a checked criterion.
- A new implementation attempt invalidates old criteria; historical receipts remain on disk.
- Final project gates and command criteria run against the combined integration tree.
- A failed or unlaunchable check does not become evidence of success.
- Retained major or critical integration findings block delivery even if the model's verdict label says PASS.
- A failed delivery is recorded as incomplete. Landed work and delivered work are separate facts.

Independent model review is another source of evidence, not a guarantee that no
bugs remain. TypeScript contract scanning has an explicit unsupported state;
other languages currently depend on declared contracts and final validation.

## Platform references

The Codex adapter uses the provider's documented sandbox controls; see
[OpenAI's Codex security documentation](https://developers.openai.com/codex/security/).
The store and checkout lock rely on SQLite's transaction and locking behavior;
see [SQLite isolation](https://www.sqlite.org/isolation.html).

These explain the underlying mechanisms. ARC's regression suite tests its own
use of them; neither reference certifies ARC's security.
