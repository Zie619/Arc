import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { ProjectConfig } from '../src/types.ts'

const schema = z.toJSONSchema(ProjectConfig, { target: 'draft-7' })
type Schema = { type?: string | string[]; enum?: unknown[]; default?: unknown; required?: string[]; properties?: Record<string, Schema>; items?: Schema }
const lines = [
  '# Configuration reference', '',
  'Generated from `ProjectConfig` in `src/types.ts`. Run `pnpm docs:config` after changing the schema.', '',
  '`arc init` detects your project and writes `arc.yaml`. `arc config` shows the effective values and their provenance.', '',
  'These are schema defaults. Auto-detection and personal role settings may supply different values.',
  'Use `landStrategy: none` for a first run, declare real gates, and keep `sandboxPolicy: refuse`.', '',
  'Setup, refresh, gates, capability probes, and approved plan proofs are executable configuration. See [security](security.md).', '',
  '| Setting | Type / accepted values | Default |', '| --- | --- | --- |',
]
const cell = (value: unknown): string => JSON.stringify(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
function visit(object: Schema, prefix = ''): void {
  for (const [name, field] of Object.entries(object.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name
    const type = field.enum ? field.enum.map((value) => `\`${cell(value)}\``).join(', ')
      : Array.isArray(field.type) ? field.type.join(', ') : field.type ?? 'object'
    const value = field.default !== undefined ? `\`${cell(field.default)}\``
      : object.required?.includes(name) ? 'required' : 'optional'
    lines.push(`| \`${path}\` | ${type} | ${value} |`)
    if (field.properties) visit(field, path)
    if (field.items?.properties) visit(field.items, `${path}[]`)
  }
}
visit(schema as Schema)
lines.push('', '## Resuming a run', '',
  'The approved plan and execution configuration are stored with the run. Resume reloads the current capability definitions and elevation grants so quarantined tasks can proceed after an operator decision. It preserves attempts, elapsed budgets, and historical evidence.', '',
  'A blocking operation pauses new scheduling. Use `arc ops`, perform the action, then `arc ops resolve ID --note "what you completed"` and `arc resume`.', '')
const content = lines.join('\n')
const path = new URL('../docs/configuration.md', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) throw new Error('configuration.md is stale; run pnpm docs:config')
} else writeFileSync(path, content)
