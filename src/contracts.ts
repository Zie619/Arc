import { spawnSync } from 'node:child_process'
import { buildGateChildEnv } from './provider-runtime.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * The measured counterpart to `contractsMutated`.
 *
 * Arc's scheduler refuses to run two tasks concurrently when they declare the
 * same contract — an exported signature, an enum, a registry map. That is the
 * answer to the failure per-branch CI is green against BY CONSTRUCTION: two
 * branches can each be green and still land contradictory versions of one
 * exported signature, because neither branch ever saw the other.
 *
 * Footprints are declared and then MEASURED (`measuredFootprint` in git.ts).
 * Contracts were declared and measured by nothing at all, which made the one
 * mechanism nothing else in this field has a 100% honour system: two tasks that
 * both forget to declare `contractsMutated: ["FooOptions"]` run concurrently,
 * land contradictory signatures, and Arc never notices.
 *
 * The measurement is the project's own compiler. `tsc --emitDeclarationOnly`
 * into a throwaway outDir prints, in canonical form, exactly the surface one
 * module presents to another — and prints it from the type checker rather than
 * from a regex over source, so an inferred return type is visible even though
 * nobody wrote it down.
 *
 * Two rules outrank the implementation:
 *
 *   1. NEVER a false green. Not TypeScript, no tsconfig, tsc unrunnable — all
 *      of those are `{ supported: false, why }`, and the caller says so out
 *      loud. An empty diff that means "we did not look" is indistinguishable
 *      from "nothing changed", and that confusion is the entire failure this
 *      subsystem exists to prevent. `contractDrift` returns null rather than
 *      an empty drift when either side is unsupported, so the difference is
 *      not expressible.
 *   2. Formatting is not drift. A reindented file or a reworded doc comment
 *      reported as a changed contract trains the operator to skim past the
 *      report, which kills the check faster than not having it.
 *
 * COST: emitting declarations is a full typecheck — seconds, not milliseconds.
 * The CALLER is expected to gate: scan only when the task's measured footprint
 * actually contains `.ts`/`.tsx` files. Nothing in here is cheap enough to run
 * speculatively.
 */

export type ContractScan =
  /** Why, phrased for a human reading an arc log — it will be shown verbatim. */
  | { supported: false; why: string }
  /** Exported symbol name -> normalised declaration text. */
  | { supported: true; symbols: Map<string, string> }

export interface ContractDrift {
  /** Exported symbols whose signature differs. */
  changed: string[]
  removed: string[]
  added: string[]
}

/** A full typecheck of somebody else's repo. Generous, but not unbounded — a
 *  scan that hangs would stall the task it was meant to observe. */
const SCAN_TIMEOUT_MS = 180_000

export function scanContracts(treePath: string): ContractScan {
  const tsconfig = join(treePath, 'tsconfig.json')
  if (!existsSync(tsconfig)) {
    return { supported: false, why: `no tsconfig.json in ${treePath} — contracts are measured by emitting TypeScript declarations, and there is nothing here to emit` }
  }

  const tsc = findTsc(treePath)
  const outDir = mkdtempSync(join(tmpdir(), 'arc-contracts-'))
  try {
    const run = spawnSync(tsc, [
      '-p', tsconfig,
      '--declaration', '--emitDeclarationOnly',
      // The project's own tsconfig almost certainly says `noEmit: true` (Arc's
      // does); without these overrides tsc politely writes nothing at all.
      '--noEmit', 'false',
      '--declarationMap', 'false',
      // Both, because `declarationDir` in the project's tsconfig would silently
      // win over `outDir` and scatter .d.ts files through the tree we are
      // measuring. A scan must not write into the worktree it observes — which
      // is also why incremental and composite are off: either one drops a
      // .tsbuildinfo next to the tsconfig.
      '--outDir', outDir, '--declarationDir', outDir,
      '--incremental', 'false', '--composite', 'false',
    ], { cwd: treePath, env: buildGateChildEnv(), encoding: 'utf8', timeout: SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })

    if (run.error) {
      const why = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? `tsc did not finish within ${SCAN_TIMEOUT_MS / 1000}s`
        : `could not run tsc (${tsc}): ${run.error.message}`
      return { supported: false, why }
    }

    const files = readdirSync(outDir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.d.ts'))
      .sort()

    // No declarations is never "no exports". It is a broken include glob, a
    // project reference we could not follow, or a tsc that refused outright —
    // all of which must read as "not measured", never as "nothing changed".
    if (files.length === 0) {
      return { supported: false, why: `tsc emitted no declarations (exit ${run.status}): ${firstLines(run.stdout, run.stderr)}` }
    }

    // Declarations ARE emitted for a program with type errors, and a task
    // mid-flight frequently has them — refusing to measure then would disable
    // the check exactly when contracts are most likely being rewritten. A
    // degraded signature (`any` where inference gave up) can only ever raise a
    // false ALARM, which is the direction this subsystem is allowed to fail in.
    const byName = new Map<string, string[]>()
    for (const file of files) {
      for (const [name, signature] of symbolsIn(readFileSync(join(outDir, file), 'utf8'))) {
        const seen = byName.get(name)
        if (seen) seen.push(signature)
        else byName.set(name, [signature])
      }
    }

    // Two files can export the same name. Keying on the bare name is what makes
    // this comparable to a declared contract string, but letting one clobber
    // the other would hide a real change behind a coincidence of naming — so
    // collisions are kept, sorted (order must not depend on readdir).
    const symbols = new Map<string, string>()
    for (const [name, signatures] of byName) symbols.set(name, [...new Set(signatures)].sort().join('\n'))
    return { supported: true, symbols }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

export function contractDrift(before: ContractScan, after: ContractScan): ContractDrift | null {
  // Null, not an empty drift. "We could not look" must not be spellable the
  // same way as "we looked and nothing moved".
  if (!before.supported || !after.supported) return null

  const changed: string[] = []
  const removed: string[] = []
  const added: string[] = []
  for (const [name, signature] of before.symbols) {
    const now = after.symbols.get(name)
    if (now === undefined) removed.push(name)
    else if (now !== signature) changed.push(name)
  }
  for (const name of after.symbols.keys()) {
    if (!before.symbols.has(name)) added.push(name)
  }
  return { changed: changed.sort(), removed: removed.sort(), added: added.sort() }
}

/**
 * Whitespace and trailing semicolons only.
 *
 * Deliberately NOT clever: `foo(a: string)` and `foo(a?: string)` are different
 * contracts and must stay different strings. Everything a normaliser is tempted
 * to unify — optionality, `readonly`, parameter names, the order of a union —
 * is something a caller can break by changing.
 *
 * Reformatting the SOURCE is already invisible before this runs: declarations
 * come out of tsc's printer, not out of the file, so two spellings of the same
 * interface emit byte-identical text. The collapse here is for the case the
 * printer does not cover — the two trees compiling under different TypeScript
 * versions, which happens the moment a task bumps the compiler.
 */
export function normaliseDeclaration(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim()
}

/** Prefer the project's own compiler: a repo pinned to TS 5.2 and a global 5.9
 *  disagree about what a declaration looks like, and that disagreement would
 *  surface as drift in code nobody touched. Never installs anything. */
function findTsc(treePath: string): string {
  for (let dir = resolve(treePath); ; dir = dirname(dir)) {
    const local = join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(local)) return local
    if (dirname(dir) === dir) return 'tsc'
  }
}

function firstLines(stdout: string | null, stderr: string | null): string {
  const text = [stderr, stdout].map((s) => (s ?? '').trim()).filter(Boolean).join('\n')
  return text ? text.split('\n').slice(0, 4).join(' / ').slice(0, 400) : '(no output)'
}

/**
 * Exported symbols of one emitted .d.ts.
 *
 * Emitted declarations are printed by tsc, not by a human, so they are already
 * canonical: one top-level declaration per statement, braces where the printer
 * puts them. That is what makes a line scanner sufficient here and would not
 * make it sufficient over source.
 */
function symbolsIn(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = []
  // Every top-level declaration, exported or not: `export { internal as bumped }`
  // refers to a `declare const internal` that carries no export keyword of its
  // own, and dropping it would make `bumped` invisible.
  const declared = new Map<string, string>()
  const deferred: string[] = []

  for (const block of topLevelBlocks(stripComments(text))) {
    const flat = normaliseDeclaration(block)
    if (!flat || flat.startsWith('import ')) continue
    // `export *` and `export { x } from` name symbols that are declared — and
    // therefore already measured — in the file they come from.
    if (/^export\s*\*/.test(flat)) continue
    if (/^export\s*\{/.test(flat) || /^export\s+default\b/.test(flat)) { deferred.push(flat); continue }
    const name = declaredName(flat)
    if (!name) continue
    declared.set(name, flat)
    if (flat.startsWith('export ')) found.push([name, flat])
  }

  for (const flat of deferred) {
    if (flat.startsWith('export default')) {
      const local = /^export default ([A-Za-z_$][\w$]*)$/.exec(flat)?.[1]
      found.push(['default', (local && declared.get(local)) || flat])
      continue
    }
    const clause = /^export\s*\{([^}]*)\}/.exec(flat)?.[1] ?? ''
    for (const spec of clause.split(',')) {
      const parts = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      const local = parts[0]?.trim()
      const exported = (parts[1] ?? parts[0])?.trim()
      if (!exported || !/^[A-Za-z_$][\w$]*$/.test(exported)) continue
      // A re-export from another module resolves to nothing here; the clause
      // itself still records that the NAME exists, which is what makes its
      // appearance or disappearance visible.
      found.push([exported, (local && declared.get(local)) || flat])
    }
  }
  return found
}

const DECLARATION =
  /^(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\*?|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/

function declaredName(flat: string): string | null {
  const body = flat.startsWith('export ') ? flat.slice('export '.length) : flat
  return DECLARATION.exec(body)?.[1] ?? null
}

/** One entry per top-level statement. A statement runs until its brackets
 *  balance again, which is the only reliable end marker: an interface body and
 *  a one-line type alias look nothing alike. */
function topLevelBlocks(src: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let depth = 0
  for (const line of src.split('\n')) {
    if (current.length === 0 && line.trim() === '') continue
    current.push(line)
    depth += netDepth(line)
    if (depth <= 0) { blocks.push(current.join('\n')); current = []; depth = 0 }
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

function netDepth(line: string): number {
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"' || c === "'" || c === '`') { i = skipString(line, i); continue }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
  }
  return depth
}

/** Index of the closing quote, or the end of the line for an unterminated one.
 *  A brace inside a string literal type (`'{'`) is not a brace. */
function skipString(text: string, start: number): number {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === quote) return i
  }
  return text.length
}

/**
 * Comments removed before anything else looks at the text.
 *
 * tsc copies JSDoc into the declarations verbatim, and this is not cosmetic:
 * a bracket that prose leaves open — "(see the incident" — is counted by the
 * depth scan above, which then swallows every declaration after it into one
 * statement. Those symbols stop existing for this module, so they are absent
 * from BOTH scans and can never show drift: a false green of the exact kind
 * rule 1 is about. Measured on Arc's own source with the stripper disabled,
 * 9 of 298 exported symbols disappeared. Newlines inside a block comment are
 * kept so that two declarations either side of one do not merge.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i)
      out += src.slice(i, Math.min(end + 1, src.length))
      i = end + 1
      continue
    }
    out += c
    i++
  }
  return out
}
