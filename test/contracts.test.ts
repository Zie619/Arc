import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanContracts, contractDrift, normaliseDeclaration, type ContractScan } from '../src/contracts.ts'

/**
 * A REAL TypeScript project, compiled by a real tsc, on every assertion below.
 * Stubbing the compiler out would test the parser against declarations no
 * compiler ever printed — and the thing most likely to be wrong here is the
 * assumption about what tsc actually emits.
 */
let project: string

const API = `
/** Options for foo (name is required; retries defaults to 0. */
export interface FooOptions {
  name: string
  retries?: number
}

export function foo(a: string, opts: FooOptions): number {
  return a.length + (opts.retries ?? 0)
}

export const VERSION = 'v1'
`

const REGISTRY = `
export enum Level { Low, High }

export function lookup(level: Level): string {
  return Level[level]
}
`

function writeBase(): void {
  writeFileSync(join(project, 'src/api.ts'), API)
  writeFileSync(join(project, 'src/registry.ts'), REGISTRY)
}

/** Everything the scan could have written into the tree it was measuring. */
function treeFiles(): string[] {
  return readdirSync(project, { recursive: true, encoding: 'utf8' })
    .filter((f) => !f.startsWith('node_modules'))
    .sort()
}

let base: ContractScan

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'arccontracts-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, types: [],
    },
    include: ['src/**/*.ts'],
  }))
  // The scan prefers the project's own compiler, so give the fixture one
  // instead of depending on a global tsc that may not exist on this machine.
  symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(project, 'node_modules'))
  writeBase()
  base = scanContracts(project)
})
afterAll(() => rmSync(project, { recursive: true, force: true }))
afterEach(writeBase)

/** Drift from the pristine project to whatever the test just wrote. */
function driftFromBase() {
  const drift = contractDrift(base, scanContracts(project))
  expect(drift).not.toBeNull()
  return drift!
}

describe('contracts are measured, not taken on trust', () => {
  it('reads the real exported surface of a real project', () => {
    expect(base.supported).toBe(true)
    if (!base.supported) return
    // Inferred, never written down in the source — which is why this is the
    // compiler's answer and not a regex's.
    expect(base.symbols.get('lookup')).toBe('export declare function lookup(level: Level): string')
    // EVERY exported symbol, none quietly missing. The unclosed bracket in the
    // fixture's doc comment is deliberate: tsc copies JSDoc into the emitted
    // declarations, and a scanner that counts that prose bracket swallows the
    // three declarations after it. They would then be absent from both scans
    // and could never show drift — invisible, not merely unreported.
    expect([...base.symbols.keys()].sort()).toEqual(['FooOptions', 'Level', 'VERSION', 'foo', 'lookup'])
  })

  it('reports a changed parameter type as drift on that symbol alone', () => {
    writeFileSync(join(project, 'src/api.ts'), API.replace('a: string', 'a: number'))
    expect(driftFromBase()).toEqual({ changed: ['foo'], removed: [], added: [] })
  })

  it('reports a changed field on an interface two tasks could both be editing', () => {
    writeFileSync(join(project, 'src/api.ts'), API.replace('retries?: number', 'retries?: string'))
    // `foo` is unchanged: it still takes a FooOptions. This is exactly the case
    // per-branch CI cannot catch — both branches compile, and the contract is
    // what disagrees.
    expect(driftFromBase()).toEqual({ changed: ['FooOptions'], removed: [], added: [] })
  })

  it('does NOT normalise away optionality', () => {
    writeFileSync(join(project, 'src/api.ts'), API.replace('opts: FooOptions', 'opts?: FooOptions'))
    // A normaliser aggressive enough to make this quiet would be worse than no
    // normaliser at all: `foo(a, opts)` and `foo(a)` are different contracts.
    expect(driftFromBase().changed).toEqual(['foo'])
  })

  it('sees an export appear and an export vanish', () => {
    writeFileSync(join(project, 'src/api.ts'), API.replace("export const VERSION = 'v1'", ''))
    writeFileSync(join(project, 'src/registry.ts'), `${REGISTRY}\nexport function fresh(n: number): string { return String(n) }\n`)
    expect(driftFromBase()).toEqual({ changed: [], removed: ['VERSION'], added: ['fresh'] })
  })

  it('does not report REFORMATTING as drift', () => {
    // Indentation, line breaks, a split declaration, rewritten prose. A check
    // that cries wolf about reformatting is one the operator learns to skim
    // past, and a skimmed contract report is worth nothing.
    writeFileSync(join(project, 'src/api.ts'), `
/** Completely rewritten prose about what foo does, at length. */
export interface FooOptions
{
      name:
            string
   retries?:     number
}


export function foo(
  a: string,
  opts: FooOptions
): number { return a.length + (opts.retries ?? 0) }
export const VERSION =
  'v1'
`)
    expect(driftFromBase()).toEqual({ changed: [], removed: [], added: [] })
  })

  it('never writes into the tree it is measuring', () => {
    // outDir alone is not enough: a tsconfig with declarationDir, or with
    // incremental/composite set, scatters .d.ts and .tsbuildinfo through the
    // worktree — inside a worktree Arc is about to diff.
    const before = treeFiles()
    expect(scanContracts(project).supported).toBe(true)
    expect(treeFiles()).toEqual(before)
  })
})

describe('an unmeasurable tree says so instead of looking clean', () => {
  it('refuses a directory with no tsconfig, and says why usably', () => {
    const bare = mkdtempSync(join(tmpdir(), 'arcbare-'))
    writeFileSync(join(bare, 'main.py'), 'print("not typescript")\n')
    try {
      const scan = scanContracts(bare)
      expect(scan.supported).toBe(false)
      if (scan.supported) return
      expect(scan.why).toContain('tsconfig.json')
      // Usable means it names the tree, so an arc log says WHICH one.
      expect(scan.why).toContain(bare)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('refuses a tsconfig that compiles nothing, and carries tsc\'s own words', () => {
    // The dangerous reading of "zero declarations emitted" is "this project
    // exports nothing, so nothing can have drifted". It is far more often a
    // broken include glob or a tsc that refused outright.
    const broken = mkdtempSync(join(tmpdir(), 'arcbroken-'))
    try {
      writeFileSync(join(broken, 'tsconfig.json'), '{"include":["nowhere/**/*.ts"]}')
      symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(broken, 'node_modules'))
      const scan = scanContracts(broken)
      expect(scan.supported).toBe(false)
      if (scan.supported) return
      expect(scan.why).toContain('no declarations')
      // Verbatim compiler output, because the operator has to fix the cause
      // and a paraphrase would not tell them what it was.
      expect(scan.why).toContain('TS18003')
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })

  it('uses the project\'s own compiler, and says so when there is none to use', () => {
    // A repo pinned to an older TypeScript and a global newer one disagree
    // about how a declaration prints, and that disagreement would surface as
    // drift in code nobody touched. PATH is stripped of any global tsc (but
    // not of /usr/bin, which the .bin shim itself needs) so that a scan can
    // only succeed by having found the local one.
    const path = process.env.PATH
    const project2 = mkdtempSync(join(tmpdir(), 'arclocaltsc-'))
    try {
      process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`
      expect(scanContracts(project).supported).toBe(true)

      // And with no compiler reachable at all, the honest answer is "unmeasured".
      mkdirSync(join(project2, 'src'))
      writeFileSync(join(project2, 'src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(project2, 'tsconfig.json'), '{"include":["src/**/*.ts"]}')
      const scan = scanContracts(project2)
      expect(scan.supported).toBe(false)
      if (!scan.supported) expect(scan.why).toContain('tsc')
    } finally {
      process.env.PATH = path
      rmSync(project2, { recursive: true, force: true })
    }
  })

  it('returns null rather than an empty drift when either side is unmeasured', () => {
    const unsupported: ContractScan = { supported: false, why: 'no tsconfig.json' }
    // An empty ContractDrift would read as "measured, nothing moved" — the one
    // false green this whole module exists to prevent.
    expect(contractDrift(unsupported, base)).toBeNull()
    expect(contractDrift(base, unsupported)).toBeNull()
    expect(contractDrift(unsupported, unsupported)).toBeNull()
    expect(contractDrift(base, base)).toEqual({ changed: [], removed: [], added: [] })
  })
})

describe('normalisation', () => {
  it('collapses layout and trailing semicolons, and nothing else', () => {
    expect(normaliseDeclaration('export interface A {\n    b:   string;\n}\n'))
      .toBe(normaliseDeclaration('export interface A { b: string; }'))
    expect(normaliseDeclaration('export declare function f(a: string): void;'))
      .toBe('export declare function f(a: string): void')
    expect(normaliseDeclaration('f(a: string)')).not.toBe(normaliseDeclaration('f(a?: string)'))
  })
})
