import { spawn } from 'node:child_process'

export type ProviderName = 'claude' | 'codex'

export const PROVIDER_CAPABILITIES = [
  'boundedRuns',
  'streamingEvents',
  'structuredOutput',
  'modelSelection',
  'effort',
  'projectInstructions',
  'mcp',
  'plugins',
  'hooks',
  'skills',
  'customAgents',
  'sessions',
  'resume',
  'fork',
  'steering',
  'nativeReview',
  'appServer',
  'subagents',
  'images',
] as const

export type ProviderCapability = typeof PROVIDER_CAPABILITIES[number]
export type CapabilityStatus = 'supported' | 'available-disabled' | 'unsupported' | 'unknown'

export interface CapabilityEvidence {
  status: CapabilityStatus
  /** The exact help flag, command or feature row which proved this status. */
  evidence: string[]
}

export interface ProviderCapabilityManifest {
  provider: ProviderName
  binary: ProviderName
  installed: boolean
  version?: string
  capabilities: Record<ProviderCapability, CapabilityEvidence>
  diagnostics: string[]
}

export interface ProviderDoctorReport {
  probedAt: string
  ready: boolean
  providers: ProviderCapabilityManifest[]
}

/**
 * An agent is a child process with code execution. Giving it the parent's
 * complete environment also gives it every unrelated credential exported in
 * the operator's shell. Build the environment deliberately instead.
 *
 * HOME and the provider-specific config directory carry subscription login.
 * Explicit provider API credentials are retained for installations that use
 * them. Project/service credentials (AWS, GitHub, npm, databases, and generic
 * *_TOKEN / *_SECRET / *_PASSWORD values) are intentionally absent.
 */
const RUNTIME_ENV = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  // NOTE: OTEL_* is deliberately NOT here. It reaches a child only when the
  // operator sets ARC_TELEMETRY=1 — see buildProviderChildEnv.
])

const PROVIDER_ENV: Record<ProviderName, ReadonlySet<string>> = {
  claude: new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  ]),
  codex: new Set([
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME',
  ]),
}

// These are Arc's own control channel. They are needed by the token-free fake
// CLIs and may also be used by a supervised runtime; arbitrary parent vars do
// not pass merely because they look harmless.
function isArcRuntimeKey(key: string): boolean {
  return key === 'ARC_HOME' || key === 'ARC_RUN' ||
    key.startsWith('ARC_FAKE_') || key.startsWith('ARC_TEST_')
}

export function buildProviderChildEnv(
  provider: ProviderName,
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (RUNTIME_ENV.has(key) || PROVIDER_ENV[provider].has(key) || isArcRuntimeKey(key)) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value
  }
  // `--setting-sources project` does NOT cover auto-memory: Claude Code loads
  // the operator's own memory files regardless of it. Set last so neither the
  // parent environment nor a role allowlist can switch it back on.
  if (provider === 'claude') env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  // Claude Code emits OpenTelemetry of its own — per-tool spans, per-request
  // timing, permission waits — which is the entire INSIDE of an attempt that
  // Arc otherwise sees as a black box with a final answer. OTEL_* is
  // deliberately absent from RUNTIME_ENV so nothing leaks by accident, so this
  // requires the operator to have opted in on THIS process. It sends data
  // somewhere: never infer the opt-in.
  if (provider === 'claude' && source.ARC_TELEMETRY === '1') {
    env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    for (const key of Object.keys(source)) {
      if (key.startsWith('OTEL_') && source[key] !== undefined) env[key] = source[key]
    }
  }
  return env
}

/**
 * Gates and reviewer finding checks run project commands through a shell in
 * the operator's own repository. They get the same deliberate environment an
 * agent gets — runtime basics only — never the operator's full shell, which
 * would hand every exported credential to any command a model authored. A
 * gate that genuinely needs a variable declares it in its own `envAllowlist`,
 * the same declared-need rule as RoleBinding.envAllowlist.
 */
export function buildGateChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  allow: readonly string[] = [],
): NodeJS.ProcessEnv {
  const extra = new Set(allow)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (RUNTIME_ENV.has(key) || extra.has(key) || isArcRuntimeKey(key)) env[key] = value
  }
  env.CI = '1'
  return env
}

interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  spawnError?: string
}

export interface ProbeOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

const MAX_PROBE_BYTES = 512 * 1024

/** Run a metadata-only CLI command. No prompt is ever supplied. */
async function runProbe(
  provider: ProviderName,
  args: string[],
  options: ProbeOptions,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    const child = spawn(provider, args, {
      cwd: options.cwd,
      env: buildProviderChildEnv(provider, options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let truncated = false

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_PROBE_BYTES) {
        truncated = true
        return current
      }
      const next = current + chunk.toString()
      if (next.length <= MAX_PROBE_BYTES) return next
      truncated = true
      return next.slice(0, MAX_PROBE_BYTES)
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (truncated) result.stderr += '\n[arc: probe output truncated]'
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, stdout, stderr: `${stderr}\n[arc: probe timed out]`, exitCode: null })
    }, options.timeoutMs ?? 5_000)
    child.on('error', (error) => finish({
      ok: false, stdout, stderr, exitCode: null, spawnError: error.message,
    }))
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, exitCode: code }))
  })
}

const helpProbeCache = new Map<ProviderName, Promise<string | null>>()

/** Probe the provider's help surface once per process for dispatch preflight. */
export function getProviderHelpText(
  provider: ProviderName,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const cached = helpProbeCache.get(provider)
  if (cached) return cached

  const probe = (async (): Promise<string | null> => {
    const results = await Promise.all([
      runProbe(provider, ['--help'], { env }),
      ...(provider === 'codex' ? [runProbe(provider, ['exec', '--help'], { env })] : []),
    ])
    if (results.some(result => !result.ok)) return null
    const text = results.map(result => result.stdout || result.stderr).join('\n').trim()
    return text || null
  })()
  helpProbeCache.set(provider, probe)
  return probe
}

/** Tests may swap PATH-selected fakes; production must retain process memoization. */
export function resetHelpProbeCacheForTests(): void {
  helpProbeCache.clear()
}

interface FeatureFlag {
  stage: string
  enabled: boolean
  line: string
}

function parseFeatureFlags(text: string): Map<string, FeatureFlag> {
  const flags = new Map<string, FeatureFlag>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const match = line.match(/^(\S+)\s{2,}(.+?)\s{2,}(true|false)$/)
    if (!match?.[1] || !match[2] || !match[3]) continue
    flags.set(match[1], { stage: match[2].trim(), enabled: match[3] === 'true', line })
  }
  return flags
}

function unknownCapabilities(): Record<ProviderCapability, CapabilityEvidence> {
  const capabilities = Object.create(null) as Record<ProviderCapability, CapabilityEvidence>
  for (const capability of PROVIDER_CAPABILITIES) {
    capabilities[capability] = { status: 'unknown', evidence: [] }
  }
  return capabilities
}

function helpEvidence(text: string, pattern: RegExp): string | undefined {
  return text.split('\n').map(line => line.trim()).find(line => pattern.test(line))
}

function markHelp(
  capabilities: Record<ProviderCapability, CapabilityEvidence>,
  name: ProviderCapability,
  help: string,
  pattern: RegExp,
): void {
  const evidence = helpEvidence(help, pattern)
  if (evidence) capabilities[name] = { status: 'supported', evidence: [evidence] }
}

function markFlag(
  capabilities: Record<ProviderCapability, CapabilityEvidence>,
  name: ProviderCapability,
  flags: Map<string, FeatureFlag>,
  flagName: string,
): void {
  const flag = flags.get(flagName)
  if (!flag) return
  const status: CapabilityStatus = flag.stage === 'removed'
    ? 'unsupported'
    : flag.enabled ? 'supported' : 'available-disabled'
  capabilities[name] = { status, evidence: [flag.line] }
}

/**
 * Normalize the two providers' different help surfaces. Absence is `unknown`,
 * not `unsupported`: old/new CLIs do not always advertise every feature.
 */
export function parseCapabilityManifest(
  provider: ProviderName,
  versionOutput: string,
  helpOutput: string,
  detailOutput = '',
  featureOutput = '',
): ProviderCapabilityManifest {
  const capabilities = unknownCapabilities()
  const combinedHelp = `${helpOutput}\n${detailOutput}`
  const flags = parseFeatureFlags(featureOutput)

  if (provider === 'claude') {
    markHelp(capabilities, 'boundedRuns', combinedHelp, /(?:^|, )--print\b|^-p, --print\b/)
    markHelp(capabilities, 'streamingEvents', combinedHelp, /--output-format.*stream-json/)
    markHelp(capabilities, 'structuredOutput', combinedHelp, /--json-schema\b/)
    markHelp(capabilities, 'modelSelection', combinedHelp, /--model\b/)
    markHelp(capabilities, 'effort', combinedHelp, /--effort\b/)
    markHelp(capabilities, 'projectInstructions', combinedHelp, /--setting-sources\b|CLAUDE\.md auto-discovery/)
    markHelp(capabilities, 'mcp', combinedHelp, /--mcp-config\b|^mcp\s/)
    markHelp(capabilities, 'plugins', combinedHelp, /--plugin-dir\b|^plugin\|plugins\s/)
    markHelp(capabilities, 'hooks', combinedHelp, /--include-hook-events\b|skip hooks/)
    markHelp(capabilities, 'skills', combinedHelp, /--disable-slash-commands\b|Skills still resolve/)
    markHelp(capabilities, 'customAgents', combinedHelp, /--agents\b/)
    markHelp(capabilities, 'sessions', combinedHelp, /--session-id\b/)
    markHelp(capabilities, 'resume', combinedHelp, /--resume\b/)
    markHelp(capabilities, 'fork', combinedHelp, /--fork-session\b/)
    markHelp(capabilities, 'steering', combinedHelp, /--input-format.*stream-json/)
    markHelp(capabilities, 'nativeReview', combinedHelp, /^ultrareview\s/)
    markHelp(capabilities, 'subagents', combinedHelp, /--forward-subagent-text\b/)
  } else {
    markHelp(capabilities, 'boundedRuns', combinedHelp, /^exec\s|Run Codex non-interactively/)
    markHelp(capabilities, 'streamingEvents', combinedHelp, /--json\b.*JSONL|Print events to stdout as JSONL/)
    markHelp(capabilities, 'structuredOutput', combinedHelp, /--output-schema\b/)
    markHelp(capabilities, 'modelSelection', combinedHelp, /--model\b/)
    markHelp(capabilities, 'mcp', combinedHelp, /^mcp\s/)
    markHelp(capabilities, 'plugins', combinedHelp, /^plugin\s/)
    markHelp(capabilities, 'sessions', combinedHelp, /^agents\s|shared local app-server daemon/)
    markHelp(capabilities, 'resume', combinedHelp, /^resume\s|exec\s+resume/)
    markHelp(capabilities, 'fork', combinedHelp, /^fork\s|exec\s+fork/)
    markHelp(capabilities, 'steering', combinedHelp, /^queue\s/)
    markHelp(capabilities, 'nativeReview', combinedHelp, /^review\s|exec\s+review/)
    markHelp(capabilities, 'appServer', combinedHelp, /^app-server\s/)
    markHelp(capabilities, 'images', combinedHelp, /--image\b/)
    markFlag(capabilities, 'hooks', flags, 'hooks')
    markFlag(capabilities, 'skills', flags, 'skill_search')
    markFlag(capabilities, 'subagents', flags, 'multi_agent')
  }

  return {
    provider,
    binary: provider,
    installed: true,
    version: versionOutput.trim().split('\n').find(Boolean)?.trim(),
    capabilities,
    diagnostics: [],
  }
}

export async function probeProvider(
  provider: ProviderName,
  options: ProbeOptions = {},
): Promise<ProviderCapabilityManifest> {
  const version = await runProbe(provider, ['--version'], options)
  if (!version.ok) {
    return {
      provider,
      binary: provider,
      installed: false,
      capabilities: unknownCapabilities(),
      diagnostics: [version.spawnError ?? (version.stderr.trim() || `${provider} --version failed`)],
    }
  }

  const help = await runProbe(provider, ['--help'], options)
  const detail = provider === 'codex'
    ? await runProbe(provider, ['exec', '--help'], options)
    : { ok: true, stdout: '', stderr: '', exitCode: 0 }
  const features = provider === 'codex'
    ? await runProbe(provider, ['features', 'list'], options)
    : { ok: true, stdout: '', stderr: '', exitCode: 0 }
  const diagnostics: string[] = []
  if (!help.ok) diagnostics.push(`${provider} --help failed: ${help.stderr.trim() || help.exitCode}`)
  if (!detail.ok) diagnostics.push(`${provider} exec --help failed: ${detail.stderr.trim() || detail.exitCode}`)
  if (!features.ok) diagnostics.push(`${provider} features list failed: ${features.stderr.trim() || features.exitCode}`)

  const manifest = parseCapabilityManifest(
    provider,
    version.stdout || version.stderr,
    help.stdout || help.stderr,
    detail.stdout || detail.stderr,
    features.stdout || features.stderr,
  )
  manifest.diagnostics.push(...diagnostics)
  return manifest
}

export async function doctorProviders(options: ProbeOptions = {}): Promise<ProviderDoctorReport> {
  const providers = await Promise.all([
    probeProvider('claude', options),
    probeProvider('codex', options),
  ])
  const required: ProviderCapability[] = ['boundedRuns', 'streamingEvents', 'structuredOutput']
  return {
    probedAt: new Date().toISOString(),
    ready: providers.every(provider => provider.installed &&
      required.every(capability => provider.capabilities[capability].status === 'supported')),
    providers,
  }
}
