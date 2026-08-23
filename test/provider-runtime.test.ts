import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildProviderChildEnv,
  doctorProviders,
  getProviderHelpText,
  parseCapabilityManifest,
  probeProvider,
  resetHelpProbeCacheForTests,
} from '../src/provider-runtime.ts'

const temporaryDirs: string[] = []
afterEach(() => {
  resetHelpProbeCacheForTests()
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('provider child environments', () => {
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/operator',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    ANTHROPIC_API_KEY: 'anthropic-auth',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
    OPENAI_API_KEY: 'openai-auth',
    CODEX_HOME: '/home/operator/.codex',
    GITHUB_TOKEN: 'unrelated-secret',
    AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
    DATABASE_URL: 'postgres://secret',
    NPM_TOKEN: 'unrelated-secret',
    NODE_OPTIONS: '--require=/tmp/inject.js',
    ARC_FAKE_PAYLOAD: '{}',
  }

  it('keeps only runtime, Arc, and Claude authentication values', () => {
    const env = buildProviderChildEnv('claude', source, { ARC_RUN: '1' })
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin', HOME: '/home/operator', LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/ssh.sock', ANTHROPIC_API_KEY: 'anthropic-auth',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth', ARC_FAKE_PAYLOAD: '{}', ARC_RUN: '1',
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('DATABASE_URL')
    expect(env).not.toHaveProperty('NPM_TOKEN')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
  })

  it('keeps Codex authentication without leaking Claude credentials', () => {
    const env = buildProviderChildEnv('codex', source)
    expect(env.OPENAI_API_KEY).toBe('openai-auth')
    expect(env.CODEX_HOME).toBe('/home/operator/.codex')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('adds project credentials only through an explicit role allowlist', () => {
    const env = buildProviderChildEnv('claude', source, { DATABASE_URL: source.DATABASE_URL })
    expect(env.DATABASE_URL).toBe('postgres://secret')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
  })
})

describe('capability normalization', () => {
  it('detects Claude capabilities only from advertised help', () => {
    const manifest = parseCapabilityManifest('claude', '2.1.239 (Claude Code)', `
      -p, --print  Print response and exit
      --output-format <format> text, json, stream-json
      --json-schema <schema> Structured output
      --model <model> Select model
      --effort <level> low, medium, high, xhigh, max
      --setting-sources <sources> user, project, local
      --mcp-config <configs...> Load MCP servers
      --plugin-dir <path> Load a plugin
      --include-hook-events Include hook events
      --disable-slash-commands Disable all skills
      --agents <json> Define custom agents
      --session-id <uuid> Session id
      -r, --resume [value] Resume
      --fork-session Fork when resuming
      --input-format <format> text or stream-json
      --forward-subagent-text Forward subagent events
      ultrareview  Run code review
    `)
    expect(manifest.installed).toBe(true)
    expect(manifest.version).toBe('2.1.239 (Claude Code)')
    expect(manifest.capabilities.effort.status).toBe('supported')
    expect(manifest.capabilities.projectInstructions.status).toBe('supported')
    expect(manifest.capabilities.subagents.status).toBe('supported')
    expect(manifest.capabilities.appServer.status).toBe('unknown')
  })

  it('distinguishes enabled, disabled, and removed Codex feature flags', () => {
    const manifest = parseCapabilityManifest(
      'codex',
      'codex-cli 0.149.0',
      'exec  Run Codex non-interactively\napp-server  Run app server\nqueue  Queue a message',
      '--json  Print events to stdout as JSONL\n--output-schema <FILE>\n-i, --image <FILE>',
      [
        'hooks                                    stable             true',
        'skill_search                             stable             false',
        'multi_agent                              removed            true',
      ].join('\n'),
    )
    expect(manifest.capabilities.streamingEvents.status).toBe('supported')
    expect(manifest.capabilities.hooks.status).toBe('supported')
    expect(manifest.capabilities.skills.status).toBe('available-disabled')
    expect(manifest.capabilities.subagents.status).toBe('unsupported')
  })
})

function writeFakeProvider(dir: string, provider: 'claude' | 'codex', body: string): void {
  const path = join(dir, provider)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('dispatch help probing', () => {
  it('memoizes the in-flight help probe once per provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-help-probe-'))
    temporaryDirs.push(dir)
    const counter = join(dir, 'counter')
    writeFileSync(counter, '')
    writeFakeProvider(dir, 'claude', `
printf x >> "$ARC_TEST_COUNTER"
printf '%s\\n' '--effort' '--no-session-persistence' '--strict-mcp-config' '--setting-sources' '--json-schema'`)

    const env = { PATH: dir, ARC_TEST_COUNTER: counter }
    const [first, second] = await Promise.all([
      getProviderHelpText('claude', env),
      getProviderHelpText('claude', env),
    ])

    expect(first).toContain('--effort')
    expect(second).toBe(first)
    expect(readFileSync(counter, 'utf8')).toBe('x')
  })

  it('resolves null when a help probe fails or returns no output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-help-probe-'))
    temporaryDirs.push(dir)
    writeFakeProvider(dir, 'claude', 'exit 9')
    expect(await getProviderHelpText('claude', { PATH: dir })).toBeNull()

    resetHelpProbeCacheForTests()
    writeFakeProvider(dir, 'claude', 'exit 0')
    expect(await getProviderHelpText('claude', { PATH: dir })).toBeNull()
  })
})

describe('runtime doctor', () => {
  it('reports an absent binary without throwing or guessing capabilities', async () => {
    const manifest = await probeProvider('claude', { env: { PATH: '/definitely/missing' } })
    expect(manifest.installed).toBe(false)
    expect(manifest.capabilities.structuredOutput.status).toBe('unknown')
    expect(manifest.diagnostics[0]).toMatch(/ENOENT|not found/i)
  })

  it('probes versions, help, and Codex feature state without a model prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-provider-probe-'))
    temporaryDirs.push(dir)
    writeFakeProvider(dir, 'claude', `
case "$1" in
  --version) printf '%s\\n' '2.1.239 (Claude Code)' ;;
  --help) printf '%s\\n' '-p, --print' '--output-format stream-json' '--json-schema <schema>' '--model <model>' '--effort <level>' ;;
  *) exit 9 ;;
esac`)
    writeFakeProvider(dir, 'codex', `
case "$1 $2" in
  '--version ') printf '%s\\n' 'codex-cli 0.149.0' ;;
  '--help ') printf '%s\\n' 'exec  Run Codex non-interactively' 'app-server  Run server' ;;
  'exec --help') printf '%s\\n' '--json  Print events to stdout as JSONL' '--output-schema <FILE>' ;;
  'features list') printf '%s\\n' 'hooks  stable  true' 'skill_search  stable  true' 'multi_agent  stable  true' ;;
  *) exit 9 ;;
esac`)

    const report = await doctorProviders({ env: { PATH: dir } })
    expect(report.ready).toBe(true)
    expect(report.providers.map(provider => provider.version)).toEqual([
      '2.1.239 (Claude Code)', 'codex-cli 0.149.0',
    ])
    expect(report.providers[1]?.capabilities.subagents.status).toBe('supported')
  })
})
