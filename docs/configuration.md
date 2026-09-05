# Configuration reference

Generated from `ProjectConfig` in `src/types.ts`. Run `pnpm docs:config` after changing the schema.

`arc init` detects your project and writes `arc.yaml`. `arc config` shows the effective values and their provenance.

These are schema defaults. Auto-detection and personal role settings may supply different values.
Use `landStrategy: none` for a first run, declare real gates, and keep `sandboxPolicy: refuse`.

Setup, refresh, gates, capability probes, and approved plan proofs are executable configuration. See [security](security.md).

| Setting | Type / accepted values | Default |
| --- | --- | --- |
| `name` | string | required |
| `repo` | string | required |
| `mainBranch` | string | `"main"` |
| `landStrategy` | `"push"`, `"pr"`, `"none"` | `"pr"` |
| `sandboxPolicy` | `"caveat"`, `"refuse"` | `"refuse"` |
| `capabilities` | object | `{}` |
| `reviewRiskPhase` | boolean | `true` |
| `dryRunProofs` | boolean | `true` |
| `notifyCommand` | array | optional |
| `maxRepairAttempts` | integer | `1` |
| `maxRepairMinutes` | integer | `30` |
| `protectedGatePaths` | array | `["vitest.config.*","jest.config.*","pytest.ini","conftest.py",".github/workflows/**","arc.yaml"]` |
| `protectedTestPaths` | array | `["**/*.test.*","**/*.spec.*","test/**","tests/**","__tests__/**"]` |
| `gates` | array | `[]` |
| `gates[].name` | string | required |
| `gates[].command` | string | required |
| `gates[].proves` | string | required |
| `gates[].cwd` | string | `"."` |
| `gates[].timeoutMs` | integer | `1200000` |
| `gates[].heavy` | boolean | `false` |
| `gates[].baselineSubset` | boolean | `false` |
| `gates[].envAllowlist` | array | optional |
| `gates[].readOnly` | boolean | optional |
| `gates[].requires` | array | optional |
| `setupCommand` | string | optional |
| `refreshCommands` | array | optional |
| `refreshCommands[].name` | string | required |
| `refreshCommands[].command` | string | required |
| `refreshCommands[].timeoutMs` | integer | optional |
| `roles` | object | required |
| `roles.head` | object | optional |
| `roles.head.cli` | `"codex"`, `"claude"` | required |
| `roles.head.model` | string | required |
| `roles.head.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.head.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.head.tools` | string | optional |
| `roles.head.envAllowlist` | array | `[]` |
| `roles.head.timeoutMs` | integer | `1800000` |
| `roles.head.stallMs` | integer | `300000` |
| `roles.triage` | object | optional |
| `roles.triage.cli` | `"codex"`, `"claude"` | required |
| `roles.triage.model` | string | required |
| `roles.triage.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.triage.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.triage.tools` | string | optional |
| `roles.triage.envAllowlist` | array | `[]` |
| `roles.triage.timeoutMs` | integer | `1800000` |
| `roles.triage.stallMs` | integer | `300000` |
| `roles.scout` | object | optional |
| `roles.scout.cli` | `"codex"`, `"claude"` | required |
| `roles.scout.model` | string | required |
| `roles.scout.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.scout.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.scout.tools` | string | optional |
| `roles.scout.envAllowlist` | array | `[]` |
| `roles.scout.timeoutMs` | integer | `1800000` |
| `roles.scout.stallMs` | integer | `300000` |
| `roles.implement` | object | required |
| `roles.implement.cli` | `"codex"`, `"claude"` | required |
| `roles.implement.model` | string | required |
| `roles.implement.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.implement.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.implement.tools` | string | optional |
| `roles.implement.envAllowlist` | array | `[]` |
| `roles.implement.timeoutMs` | integer | `1800000` |
| `roles.implement.stallMs` | integer | `300000` |
| `roles.review` | object | optional |
| `roles.review.cli` | `"codex"`, `"claude"` | required |
| `roles.review.model` | string | required |
| `roles.review.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.review.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.review.tools` | string | optional |
| `roles.review.envAllowlist` | array | `[]` |
| `roles.review.timeoutMs` | integer | `1800000` |
| `roles.review.stallMs` | integer | `300000` |
| `roles.integrate` | object | optional |
| `roles.integrate.cli` | `"codex"`, `"claude"` | required |
| `roles.integrate.model` | string | required |
| `roles.integrate.effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` |
| `roles.integrate.sandbox` | `"read-only"`, `"workspace-write"`, `"danger-full-access"` | `"read-only"` |
| `roles.integrate.tools` | string | optional |
| `roles.integrate.envAllowlist` | array | `[]` |
| `roles.integrate.timeoutMs` | integer | `1800000` |
| `roles.integrate.stallMs` | integer | `300000` |
| `agentConcurrency` | integer | `3` |
| `heavyGateLimit` | integer | `1` |
| `maxAttempts` | integer | `4` |
| `maxTaskMinutes` | integer | `90` |
| `capacityWaitMinutes` | number | `240` |

## Resuming a run

The approved plan and execution configuration are stored with the run. Resume reloads the current capability definitions and elevation grants so quarantined tasks can proceed after an operator decision. It preserves attempts, elapsed budgets, and historical evidence.

A blocking operation pauses new scheduling. Use `arc ops`, perform the action, then `arc ops resolve ID --note "what you completed"` and `arc resume`.
