import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ClaimTier, Plan, TerminalReason, AgentRole, ProviderUsage } from './types.ts'
import { TIER_RANK } from './types.ts'

/**
 * The only writer of durable state.
 *
 * Organising rule: anything a human or an agent REASONED about is immutable
 * and append-only. Anything the scheduler COMPUTES is derived. There is no
 * third category — no mutable prose field anywhere.
 *
 * Uses node:sqlite (built into Node ≥22.5), so there is no native module to
 * compile and no dependency to break on a Node upgrade.
 */

// Forward-only. Never edited in place; a change is a new statement appended.
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS arc (
     id TEXT PRIMARY KEY,
     thread_id TEXT,
     charter_json TEXT NOT NULL,
     plan_json TEXT NOT NULL,
     repo TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     integration_branch TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'running',
     created_at INTEGER NOT NULL,
     closed_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS task (
     arc_id TEXT NOT NULL,
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     spec TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     lease_expires_at INTEGER,
     base_sha TEXT,
     head_sha TEXT,
     branch TEXT,
     worktree TEXT,
     footprint_measured TEXT,
     started_at INTEGER,
     ended_at INTEGER,
     PRIMARY KEY (arc_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS attempt (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     task_id TEXT,
     attempt_no INTEGER NOT NULL,
     role TEXT NOT NULL,
     requested_model TEXT NOT NULL,
     observed_model TEXT,
     cli TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     terminal_reason TEXT,
     exit_code INTEGER,
     base_sha TEXT,
     head_sha TEXT,
     brief_artifact_id TEXT,
     transcript_artifact_id TEXT,
     effort TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS criterion (
     arc_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     id TEXT NOT NULL,
     text TEXT NOT NULL,
     proof_kind TEXT NOT NULL,
     proof_command TEXT,
     required_tier TEXT NOT NULL,
     tier TEXT NOT NULL DEFAULT 'unproven',
     evidence TEXT,
     evidence_artifact_id TEXT,
     proved_at INTEGER,
     PRIMARY KEY (arc_id, task_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS event (
     arc_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     task_id TEXT,
     attempt_id TEXT,
     kind TEXT NOT NULL,
     payload TEXT,
     PRIMARY KEY (arc_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS artifact (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     attempt_id TEXT,
     kind TEXT NOT NULL,
     path TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS finding (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     attempt_id TEXT,
     task_id TEXT,
     kind TEXT NOT NULL,
     severity TEXT NOT NULL DEFAULT 'low',
     text TEXT NOT NULL,
     affects_json TEXT NOT NULL DEFAULT '[]',
     resolution TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gate_run (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     task_id TEXT,
     attempt_id TEXT,
     name TEXT NOT NULL,
     command TEXT NOT NULL,
     proves TEXT NOT NULL,
     exit_code INTEGER,
     base_sha TEXT NOT NULL,
     verdict TEXT NOT NULL,
     signature TEXT,
     artifact_id TEXT,
     duration_ms INTEGER,
     ran_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS pending_op (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     task_id TEXT,
     kind TEXT NOT NULL,
     description TEXT NOT NULL,
     blocking INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'open',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attempt_usage (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     cache_write_input_tokens INTEGER,
     output_tokens INTEGER,
     reasoning_output_tokens INTEGER,
     cache_write_5m_tokens INTEGER,
     cache_write_1h_tokens INTEGER,
     usage_semantics TEXT NOT NULL DEFAULT 'subset',
     cost_usd REAL,
     raw_json TEXT NOT NULL,
     recorded_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS run_snapshot (
     arc_id TEXT PRIMARY KEY,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS finding_evidence (
     finding_id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     command TEXT NOT NULL,
     exit_code INTEGER,
     verdict TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (finding_id, artifact_id)
   )`,
  `CREATE TABLE IF NOT EXISTS thread (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     title TEXT NOT NULL,
     lane TEXT NOT NULL DEFAULT 'chat',
     lane_source TEXT NOT NULL DEFAULT 'auto',
     status TEXT NOT NULL DEFAULT 'active',
     parent_thread_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_message (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_agreement (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     goal TEXT NOT NULL,
     constraints_json TEXT NOT NULL DEFAULT '[]',
     decisions_json TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     UNIQUE(thread_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS thread_context_snapshot (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     provider TEXT,
     model TEXT,
     context_text TEXT NOT NULL,
     included_messages_json TEXT NOT NULL,
     included_artifacts_json TEXT NOT NULL,
     omitted_json TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS intervention (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     arc_id TEXT,
     task_id TEXT,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     applied_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS workflow_run (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     definition_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'running',
     created_at INTEGER NOT NULL,
     ended_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS workflow_step_state (
     run_id TEXT NOT NULL,
     step_id TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     attempt INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER,
     ended_at INTEGER,
     PRIMARY KEY (run_id, step_id)
   )`,
  // ---- design phase (interview → scouts → plan), before an arc exists ----
  `CREATE TABLE IF NOT EXISTS design (
     arc_id TEXT PRIMARY KEY,
     thread_id TEXT,
     brief_text TEXT NOT NULL,
     charter_json TEXT,
     status TEXT NOT NULL DEFAULT 'interviewing',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS decision (
     id TEXT PRIMARY KEY,
     arc_id TEXT NOT NULL,
     question TEXT NOT NULL,
     chosen TEXT NOT NULL,
     rationale TEXT,
     rejected_json TEXT NOT NULL DEFAULT '[]',
     decided_by TEXT NOT NULL,
     supersedes TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS premise (
     id TEXT NOT NULL,
     arc_id TEXT NOT NULL,
     statement TEXT NOT NULL,
     how_to_verify TEXT,
     status TEXT NOT NULL DEFAULT 'assumed',
     evidence TEXT,
     checked_at INTEGER,
     PRIMARY KEY (arc_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS scout (
     id TEXT NOT NULL,
     arc_id TEXT NOT NULL,
     area TEXT NOT NULL,
     engine TEXT NOT NULL,
     model TEXT,
     report_json TEXT,
     terminal_reason TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (arc_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS event_arc_seq ON event (arc_id, seq)`,
  `CREATE INDEX IF NOT EXISTS attempt_task ON attempt (arc_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS thread_repo_updated ON thread (repo, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS thread_message_order ON thread_message (thread_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS intervention_pending ON intervention (thread_id, status, created_at)`,
]

export interface EventRow {
  seq: number
  at: number
  taskId: string | null
  attemptId: string | null
  kind: string
  payload: unknown
}

export class Store {
  private db: DatabaseSync
  readonly root: string

  constructor(root: string) {
    this.root = root
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    this.db = new DatabaseSync(join(root, 'arc.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL lets a reader and a writer coexist; it does NOT serialize two writers
    // — the second gets SQLITE_BUSY immediately without this. `arc run
    // --until-done` keeps a Store open in the supervisor while its child opens
    // the same file, so contention is now reachable, and a throw here becomes a
    // crash and a relaunch.
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    for (const m of MIGRATIONS) this.db.exec(m)
    // Columns added after a table shipped. CREATE IF NOT EXISTS cannot alter
    // an existing database, so each addition is guarded by table_info.
    this.ensureColumn('thread', 'lane_source', `TEXT NOT NULL DEFAULT 'auto'`)
    // Arc↔thread linkage used to exist only inside a lane.start event payload.
    this.ensureColumn('arc', 'thread_id', 'TEXT')
    this.ensureColumn('design', 'thread_id', 'TEXT')
    // A 1-hour cache write is 2.0x base input and a 5-minute one is 1.25x, and
    // the two providers disagree about whether cached tokens sit inside
    // input_tokens or beside it. One column cannot carry either fact.
    this.ensureColumn('attempt_usage', 'cache_write_5m_tokens', 'INTEGER')
    this.ensureColumn('attempt_usage', 'cache_write_1h_tokens', 'INTEGER')
    this.ensureColumn('attempt_usage', 'usage_semantics', `TEXT NOT NULL DEFAULT 'subset'`)
    // effort lived only in RoleBinding and the frozen config blob, which made
    // "is xhigh worth it?" unanswerable from the data.
    this.ensureColumn('attempt', 'effort', 'TEXT')
    // runGate already computes this and recordGate threw it away.
    this.ensureColumn('gate_run', 'duration_ms', 'INTEGER')
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }

  close(): void {
    this.db.close()
  }

  // -- arc ------------------------------------------------------------------

  createArc(plan: Plan, repo: string, baseSha: string, integrationBranch: string, threadId?: string): void {
    this.db
      .prepare(
        `INSERT INTO arc (id, thread_id, charter_json, plan_json, repo, base_sha, integration_branch, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        plan.arcId,
        threadId ?? null,
        JSON.stringify(plan.charter),
        JSON.stringify(plan),
        repo,
        baseSha,
        integrationBranch,
        Date.now(),
      )

    for (const t of plan.tasks) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO task (arc_id, id, title, spec, state) VALUES (?, ?, ?, ?, 'pending')`,
        )
        .run(plan.arcId, t.id, t.title, t.spec)
      for (const c of t.acceptance) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO criterion
               (arc_id, task_id, id, text, proof_kind, proof_command, required_tier, tier)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'unproven')`,
          )
          .run(plan.arcId, t.id, c.id, c.text, c.proofKind, c.proofCommand ?? null, c.requiredTier)
      }
    }
  }

  getArc(arcId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM arc WHERE id = ?`).get(arcId) as
      | Record<string, unknown>
      | undefined
  }

  getPlan(arcId: string): Plan | undefined {
    const row = this.db.prepare(`SELECT plan_json FROM arc WHERE id = ?`).get(arcId) as
      | { plan_json: string }
      | undefined
    return row ? (JSON.parse(row.plan_json) as Plan) : undefined
  }

  /** Configuration is frozen with the run; resume must not reinterpret an old
   *  plan using whatever project.yaml happens to say today. */
  saveRunSnapshot(arcId: string, config: unknown): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO run_snapshot (arc_id, config_json, created_at) VALUES (?, ?, ?)`,
    ).run(arcId, JSON.stringify(config), Date.now())
  }

  getRunSnapshot(arcId: string): unknown | undefined {
    const row = this.db.prepare(`SELECT config_json FROM run_snapshot WHERE arc_id = ?`).get(arcId) as
      | { config_json: string }
      | undefined
    return row ? JSON.parse(row.config_json) : undefined
  }

  closeArc(arcId: string, status: 'done' | 'incomplete'): void {
    this.db.prepare(`UPDATE arc SET status = ?, closed_at = ? WHERE id = ?`).run(status, Date.now(), arcId)
  }

  /** Every arc, newest first — what the dashboard lists. */
  allArcs(): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT id, status, repo, base_sha, integration_branch, created_at, closed_at, charter_json
                FROM arc ORDER BY created_at DESC`)
      .all() as any
  }

  /** Live counts for one arc, computed rather than stored. */
  arcSummary(arcId: string): { total: number; landed: number; failed: number; running: number; unproven: number } {
    const tasks = this.allTasks(arcId)
    const crit = this.allCriteria(arcId)
    return {
      total: tasks.length,
      landed: tasks.filter((t) => t.state === 'landed').length,
      failed: tasks.filter((t) => t.state === 'failed' || t.state === 'blocked').length,
      running: tasks.filter((t) => ['running', 'reviewing', 'landing'].includes(t.state)).length,
      unproven: crit.filter((c) => c.tier === 'unproven' || c.tier === 'claimed').length,
    }
  }

  /** The most recent attempt per task — what a live view needs for "who is on what". */
  liveAttempts(arcId: string): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT * FROM attempt WHERE arc_id = ? AND ended_at IS NULL ORDER BY started_at DESC`)
      .all(arcId) as any
  }

  /** Most recent design session — so `--id` can be omitted in the common case. */
  latestDesignId(): string | undefined {
    const r = this.db.prepare(`SELECT arc_id FROM design ORDER BY created_at DESC LIMIT 1`).get() as
      | { arc_id: string } | undefined
    return r?.arc_id
  }

  latestArcId(): string | undefined {
    const row = this.db.prepare(`SELECT id FROM arc ORDER BY created_at DESC LIMIT 1`).get() as
      | { id: string }
      | undefined
    return row?.id
  }

  // -- durable conversation threads ----------------------------------------

  createThread(input: {
    repo: string
    title: string
    lane?: string
    parentThreadId?: string
    id?: string
  }): string {
    const id = input.id ?? randomUUID()
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO thread (id, repo, title, lane, status, parent_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, input.repo, input.title, input.lane ?? 'chat', input.parentThreadId ?? null, now, now)
    return id
  }

  getThread(threadId: string): Record<string, any> | undefined {
    return this.db.prepare(`SELECT * FROM thread WHERE id = ?`).get(threadId) as any
  }

  threadsForRepo(repo: string, includeArchived = false): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM thread WHERE repo = ? ${includeArchived ? '' : "AND status = 'active'"}
       ORDER BY updated_at DESC, created_at DESC`,
    ).all(repo) as any
  }

  renameThread(threadId: string, title: string): void {
    this.db.prepare(`UPDATE thread SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), threadId)
  }

  setThreadLane(threadId: string, lane: string, source: 'user' | 'auto' = 'auto'): void {
    this.db.prepare(`UPDATE thread SET lane = ?, lane_source = ?, updated_at = ? WHERE id = ?`)
      .run(lane, source, Date.now(), threadId)
  }

  /**
   * Triage's write-back. Only an auto-routed thread may be re-routed — an
   * operator's explicit /lane choice wins. Checked at WRITE time inside one
   * statement, so a /lane typed while triage is in flight cannot be clobbered
   * by the classifier finishing later.
   */
  setThreadLaneIfAuto(threadId: string, lane: string): void {
    this.db.prepare(`UPDATE thread SET lane = ?, updated_at = ? WHERE id = ? AND lane_source != 'user'`)
      .run(lane, Date.now(), threadId)
  }

  /** Attach a thread's arc-less pending steering to the arc about to run. */
  adoptInterventions(threadId: string, arcId: string): void {
    this.db.prepare(`UPDATE intervention SET arc_id = ? WHERE thread_id = ? AND arc_id IS NULL AND status = 'pending'`)
      .run(arcId, threadId)
  }

  archiveThread(threadId: string): void {
    this.db.prepare(`UPDATE thread SET status = 'archived', updated_at = ? WHERE id = ?`)
      .run(Date.now(), threadId)
  }

  forkThread(threadId: string, title: string, id?: string): string {
    const parent = this.getThread(threadId)
    if (!parent) throw new Error(`thread "${threadId}" does not exist`)
    const child = this.createThread({
      id, repo: String(parent.repo), title, lane: String(parent.lane), parentThreadId: threadId,
    })
    const agreement = this.latestThreadAgreement(threadId)
    if (agreement) {
      this.setThreadAgreement(child, {
        goal: String(agreement.goal),
        constraints: JSON.parse(String(agreement.constraints_json)),
        decisions: JSON.parse(String(agreement.decisions_json)),
      })
    }
    return child
  }

  appendThreadMessage(threadId: string, role: 'user' | 'assistant' | 'system', text: string, id?: string): string {
    if (!this.getThread(threadId)) throw new Error(`thread "${threadId}" does not exist`)
    const messageId = id ?? randomUUID()
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO thread_message (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(messageId, threadId, role, text, now)
    this.db.prepare(`UPDATE thread SET updated_at = ? WHERE id = ?`).run(now, threadId)
    return messageId
  }

  threadMessages(threadId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM thread_message WHERE thread_id = ? ORDER BY created_at, id`,
    ).all(threadId) as any
  }

  setThreadAgreement(threadId: string, agreement: {
    goal: string
    constraints?: unknown[]
    decisions?: unknown[]
  }): number {
    if (!this.getThread(threadId)) throw new Error(`thread "${threadId}" does not exist`)
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM thread_agreement WHERE thread_id = ?`,
    ).get(threadId) as { version: number }
    this.db.prepare(
      `INSERT INTO thread_agreement
         (id, thread_id, version, goal, constraints_json, decisions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), threadId, row.version, agreement.goal,
      JSON.stringify(agreement.constraints ?? []), JSON.stringify(agreement.decisions ?? []), Date.now())
    this.db.prepare(`UPDATE thread SET updated_at = ? WHERE id = ?`).run(Date.now(), threadId)
    return row.version
  }

  latestThreadAgreement(threadId: string): Record<string, any> | undefined {
    return this.db.prepare(
      `SELECT * FROM thread_agreement WHERE thread_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as any
  }

  saveThreadContextSnapshot(input: {
    threadId: string
    provider?: string
    model?: string
    text: string
    includedMessageIds: string[]
    includedArtifactIds: string[]
    omitted: string[]
    bytes: number
  }): string {
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO thread_context_snapshot
         (id, thread_id, provider, model, context_text, included_messages_json,
          included_artifacts_json, omitted_json, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.threadId, input.provider ?? null, input.model ?? null, input.text,
      JSON.stringify(input.includedMessageIds), JSON.stringify(input.includedArtifactIds),
      JSON.stringify(input.omitted), input.bytes, Date.now())
    return id
  }

  latestThreadContextSnapshot(threadId: string): Record<string, any> | undefined {
    return this.db.prepare(
      `SELECT * FROM thread_context_snapshot WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(threadId) as any
  }

  addIntervention(input: {
    threadId: string
    kind: 'steer' | 'pause' | 'resume' | 'retry' | 'skip'
    text: string
    arcId?: string
    taskId?: string
  }): string {
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO intervention (id, thread_id, arc_id, task_id, kind, text, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, input.threadId, input.arcId ?? null, input.taskId ?? null,
      input.kind, input.text, Date.now())
    return id
  }

  pendingInterventions(threadId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM intervention WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, id`,
    ).all(threadId) as any
  }

  pendingInterventionsForArc(arcId: string, kind?: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM intervention WHERE arc_id = ? AND status = 'pending'
       ${kind ? 'AND kind = ?' : ''} ORDER BY created_at, id`,
    ).all(...(kind ? [arcId, kind] : [arcId])) as any
  }

  applyIntervention(id: string): void {
    this.db.prepare(
      `UPDATE intervention SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(Date.now(), id)
  }





  // -- design phase ----------------------------------------------------------

  /**
   * The raw brief is stored byte-for-byte and NEVER rewritten. Everything
   * downstream is a derived view of it; if a summary and the brief disagree,
   * the brief wins.
   */
  startDesign(arcId: string, briefText: string, threadId?: string): void {
    const existing = this.db.prepare(`SELECT brief_text FROM design WHERE arc_id = ?`).get(arcId) as
      | { brief_text: string }
      | undefined
    if (existing) {
      if (existing.brief_text !== briefText) {
        throw new Error(`design "${arcId}" already exists with a different immutable brief`)
      }
      // The brief stays immutable; the thread linkage may arrive later.
      if (threadId) {
        this.db.prepare(`UPDATE design SET thread_id = COALESCE(thread_id, ?) WHERE arc_id = ?`)
          .run(threadId, arcId)
      }
      return
    }
    const now = Date.now()
    this.db
      .prepare(`INSERT INTO design (arc_id, thread_id, brief_text, status, created_at, updated_at)
                VALUES (?, ?, ?, 'interviewing', ?, ?)`)
      .run(arcId, threadId ?? null, briefText, now, now)
  }

  getDesign(arcId: string): { briefText: string; charter: any | null; status: string; threadId: string | null } | undefined {
    const r = this.db.prepare(`SELECT * FROM design WHERE arc_id = ?`).get(arcId) as any
    if (!r) return undefined
    return {
      briefText: String(r.brief_text),
      charter: r.charter_json ? JSON.parse(String(r.charter_json)) : null,
      status: String(r.status),
      threadId: r.thread_id ? String(r.thread_id) : null,
    }
  }

  setCharter(arcId: string, charter: unknown, status: string): void {
    this.db
      .prepare(`UPDATE design SET charter_json = ?, status = ?, updated_at = ? WHERE arc_id = ?`)
      .run(JSON.stringify(charter), status, Date.now(), arcId)
  }

  /** Immutable. A change of mind is a NEW row that supersedes the old one. */
  addDecision(arcId: string, d: {
    question: string; chosen: string; rationale?: string
    rejected?: string[]; decidedBy: string; supersedes?: string
  }): string {
    const id = randomUUID()
    this.db
      .prepare(`INSERT INTO decision (id, arc_id, question, chosen, rationale, rejected_json, decided_by, supersedes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, arcId, d.question, d.chosen, d.rationale ?? null, JSON.stringify(d.rejected ?? []), d.decidedBy, d.supersedes ?? null, Date.now())
    return id
  }

  decisions(arcId: string): Array<Record<string, any>> {
    const all = this.db.prepare(`SELECT * FROM decision WHERE arc_id = ? ORDER BY created_at`).all(arcId) as any[]
    const superseded = new Set(all.map((d) => d.supersedes).filter(Boolean))
    return all.filter((d) => !superseded.has(d.id))
  }

  addPremise(arcId: string, id: string, statement: string, howToVerify: string): void {
    this.db
      .prepare(`INSERT INTO premise (id, arc_id, statement, how_to_verify, status)
                VALUES (?, ?, ?, ?, 'assumed')
                ON CONFLICT(arc_id, id) DO UPDATE SET
                  statement = excluded.statement,
                  how_to_verify = excluded.how_to_verify,
                  status = 'assumed',
                  evidence = NULL,
                  checked_at = NULL
                WHERE premise.status NOT IN ('confirmed', 'refuted', 'superseded')`)
      .run(id, arcId, statement, howToVerify)
  }

  setPremise(arcId: string, id: string, status: 'confirmed' | 'corrected' | 'refuted' | 'unclear' | 'superseded', evidence: string): void {
    this.db
      .prepare(`UPDATE premise SET status = ?, evidence = ?, checked_at = ? WHERE arc_id = ? AND id = ?`)
      .run(status, evidence, Date.now(), arcId, id)
  }

  premises(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM premise WHERE arc_id = ?`).all(arcId) as any
  }

  /** A refuted premise is a stop sign: the plan rests on something untrue. */
  refutedPremises(arcId: string): Array<Record<string, any>> {
    return this.premises(arcId).filter((p) => p.status === 'refuted')
  }

  saveScout(arcId: string, s: {
    id: string; area: string; engine: string; model?: string
    report?: unknown; terminalReason?: string
  }): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO scout (id, arc_id, area, engine, model, report_json, terminal_reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, arcId, s.area, s.engine, s.model ?? null,
           s.report ? JSON.stringify(s.report) : null, s.terminalReason ?? null, Date.now())
  }

  scouts(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM scout WHERE arc_id = ? ORDER BY created_at`).all(arcId) as any
  }

  scoutReports(arcId: string): any[] {
    return this.scouts(arcId).filter((s) => s.report_json).map((s) => JSON.parse(String(s.report_json)))
  }

  // -- events (append-only; never compacted, never deleted) ------------------

  appendEvent(
    arcId: string,
    kind: string,
    payload: unknown = null,
    taskId?: string | null,
    attemptId?: string | null,
  ): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM event WHERE arc_id = ?`)
      .get(arcId) as { next: number }
    this.db
      .prepare(
        `INSERT INTO event (arc_id, seq, at, task_id, attempt_id, kind, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(arcId, row.next, Date.now(), taskId ?? null, attemptId ?? null, kind, JSON.stringify(payload))
    return row.next
  }

  eventsSince(arcId: string, seq: number): EventRow[] {
    const rows = this.db
      .prepare(`SELECT seq, at, task_id, attempt_id, kind, payload FROM event WHERE arc_id = ? AND seq > ? ORDER BY seq`)
      .all(arcId, seq) as Array<Record<string, any>>
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      taskId: r.task_id,
      attemptId: r.attempt_id,
      kind: r.kind,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }))
  }

  // -- tasks ----------------------------------------------------------------

  taskRuntime(arcId: string): Record<string, { id: string; state: any; leaseExpiresAt: number | null }> {
    const rows = this.db
      .prepare(`SELECT id, state, lease_expires_at FROM task WHERE arc_id = ?`)
      .all(arcId) as Array<Record<string, any>>
    const out: Record<string, any> = {}
    for (const r of rows) out[r.id] = { id: r.id, state: r.state, leaseExpiresAt: r.lease_expires_at }
    return out
  }

  setTaskState(arcId: string, taskId: string, state: string, leaseMs?: number): void {
    this.db
      .prepare(`UPDATE task SET state = ?, lease_expires_at = ? WHERE arc_id = ? AND id = ?`)
      .run(state, leaseMs ? Date.now() + leaseMs : null, arcId, taskId)
    this.appendEvent(arcId, 'task.state', { state }, taskId)
  }

  /** Heartbeat. A lease that stops being extended is how a dead worker is found. */
  renewLease(arcId: string, taskId: string, leaseMs: number): void {
    this.db
      .prepare(`UPDATE task SET lease_expires_at = ? WHERE arc_id = ? AND id = ?`)
      .run(Date.now() + leaseMs, arcId, taskId)
  }

  setTaskWorkspace(arcId: string, taskId: string, wt: string, branch: string, baseSha: string): void {
    this.db
      .prepare(`UPDATE task SET worktree = ?, branch = ?, base_sha = ?, started_at = COALESCE(started_at, ?) WHERE arc_id = ? AND id = ?`)
      .run(wt, branch, baseSha, Date.now(), arcId, taskId)
  }

  setTaskHead(arcId: string, taskId: string, headSha: string, measured: string[]): void {
    this.db
      .prepare(`UPDATE task SET head_sha = ?, footprint_measured = ? WHERE arc_id = ? AND id = ?`)
      .run(headSha, JSON.stringify(measured), arcId, taskId)
  }

  getTask(arcId: string, taskId: string): Record<string, any> | undefined {
    return this.db.prepare(`SELECT * FROM task WHERE arc_id = ? AND id = ?`).get(arcId, taskId) as any
  }

  allTasks(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM task WHERE arc_id = ?`).all(arcId) as any
  }

  // -- attempts -------------------------------------------------------------

  startAttempt(a: {
    arcId: string
    taskId: string | null
    attemptNo: number
    role: AgentRole
    cli: string
    requestedModel: string
    baseSha?: string
    briefArtifactId?: string
    effort?: string
  }): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO attempt (id, arc_id, task_id, attempt_no, role, requested_model, cli, started_at, base_sha, brief_artifact_id, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, a.arcId, a.taskId, a.attemptNo, a.role, a.requestedModel, a.cli, Date.now(), a.baseSha ?? null, a.briefArtifactId ?? null, a.effort ?? null)
    this.appendEvent(a.arcId, 'attempt.start', { role: a.role, model: a.requestedModel, cli: a.cli }, a.taskId, id)
    return id
  }

  finishAttempt(
    arcId: string,
    attemptId: string,
    f: {
      terminalReason: TerminalReason
      exitCode: number | null
      observedModel: string | null
      transcriptArtifactId?: string
      headSha?: string
      usage?: ProviderUsage[]
    },
  ): void {
    this.db
      .prepare(
        `UPDATE attempt SET ended_at = ?, terminal_reason = ?, exit_code = ?, observed_model = ?, transcript_artifact_id = ?, head_sha = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        f.terminalReason,
        f.exitCode,
        f.observedModel,
        f.transcriptArtifactId ?? null,
        f.headSha ?? null,
        attemptId,
      )
    for (const row of f.usage ?? []) {
      this.db.prepare(
        `INSERT INTO attempt_usage
           (id, arc_id, attempt_id, provider, model, input_tokens, cached_input_tokens,
            cache_write_input_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
            usage_semantics, output_tokens, reasoning_output_tokens, cost_usd,
            raw_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), arcId, attemptId, row.provider, row.model ?? null,
        row.inputTokens ?? null, row.cachedInputTokens ?? null,
        row.cacheWriteInputTokens ?? null,
        row.cacheWrite5mTokens ?? null, row.cacheWrite1hTokens ?? null,
        row.usageSemantics, row.outputTokens ?? null,
        row.reasoningOutputTokens ?? null, row.costUsd ?? null,
        JSON.stringify(row.raw), Date.now(),
      )
    }
    const { usage, ...eventFields } = f
    this.appendEvent(arcId, 'attempt.end', {
      ...eventFields,
      usageRecords: usage?.length ?? 0,
    }, null, attemptId)
  }

  attemptCount(arcId: string, taskId: string, role: AgentRole): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM attempt WHERE arc_id = ? AND task_id = ? AND role = ?`)
      .get(arcId, taskId, role) as { n: number }
    return r.n
  }

  /**
   * Everything needed to compare two runs of the same plan. Pure SQL over rows
   * that already existed — "this run cost three times the last one" was simply
   * a question nobody had written down.
   */
  arcMetrics(arcId: string): Record<string, any> {
    const tasks = this.allTasks(arcId)
    const criteria = this.allCriteria(arcId)
    const totals = this.db.prepare(
      `SELECT COUNT(*) attempts,
              SUM(COALESCE(a.ended_at, ?) - a.started_at) wall_ms
       FROM attempt a WHERE a.arc_id = ?`,
    ).get(Date.now(), arcId) as { attempts: number; wall_ms: number }
    const byTier: Record<string, number> = {}
    for (const c of criteria) byTier[String(c.tier)] = (byTier[String(c.tier)] ?? 0) + 1
    return {
      arcId,
      status: this.getArc(arcId)?.status ?? 'missing',
      tasks: tasks.length,
      landed: tasks.filter((t) => t.state === 'landed').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
      attempts: Number(totals?.attempts ?? 0),
      wallMs: Number(totals?.wall_ms ?? 0),
      findings: this.findingsFor(arcId).length,
      byTier,
      roles: this.costSummary(arcId),
    }
  }

  /**
   * Gates that both passed and failed on the SAME base sha.
   *
   * Arc can PROVE flakiness where most CI vendors can only infer it, because
   * gate_run stores the base sha alongside the verdict: same commit, same
   * command, two different answers is not an inference, it is a contradiction.
   *
   * Never let this SUPPRESS a failure — a genuinely broken gate looks flaky for
   * a while. It is here to be surfaced, not to be swallowed.
   */
  flakyGates(minRuns = 3): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT name, base_sha,
              COUNT(*) runs,
              SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) passes,
              SUM(CASE WHEN verdict = 'fail' THEN 1 ELSE 0 END) fails
       FROM gate_run
       WHERE verdict IN ('pass', 'fail')
       GROUP BY name, base_sha
       HAVING runs >= ? AND passes > 0 AND fails > 0
       ORDER BY fails * (CAST(fails AS REAL) / runs) DESC`,
    ).all(minRuns) as any
  }

  /** Every attempt in the arc, whatever task or role. The bench counts these. */
  allAttempts(arcId: string): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT * FROM attempt WHERE arc_id = ? ORDER BY started_at`)
      .all(arcId) as any
  }

  attemptsFor(arcId: string, taskId: string): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT * FROM attempt WHERE arc_id = ? AND task_id = ? ORDER BY started_at`)
      .all(arcId, taskId) as any
  }

  /**
   * The token bill, grouped by role and CLI — with the honest gap stated:
   * attempts that reported no receipt make every total a FLOOR, not a fact.
   * A real operator burned most of two subscriptions in a day and had no way
   * to see where; this is the query that answers that question.
   */
  costSummary(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT a.role, a.cli,
              COUNT(*) attempts,
              SUM(COALESCE(a.ended_at, ?) - a.started_at) wall_ms,
              SUM(CASE WHEN u.attempt_id IS NOT NULL THEN 1 ELSE 0 END) receipted,
              SUM(COALESCE(u.inp, 0)) input_tokens,
              SUM(COALESCE(u.cin, 0)) cached_input_tokens,
              SUM(COALESCE(u.cwr, 0)) cache_write_tokens,
              SUM(COALESCE(u.billed, 0)) billed_input_tokens,
              SUM(COALESCE(u.out, 0)) output_tokens,
              SUM(COALESCE(u.rsn, 0)) reasoning_tokens,
              SUM(u.cost) cost_usd
       FROM attempt a
       LEFT JOIN (SELECT attempt_id, SUM(input_tokens) inp, SUM(cached_input_tokens) cin,
                         SUM(cache_write_input_tokens) cwr,
                         -- 'additive' (Anthropic): input, cache-read and cache-write
                         -- are three separate buckets. 'subset' (OpenAI): the cached
                         -- ones are already inside input_tokens. Summing one column
                         -- across both providers is wrong for one of them.
                         SUM(CASE WHEN usage_semantics = 'additive'
                                  THEN COALESCE(input_tokens, 0) + COALESCE(cached_input_tokens, 0)
                                       + COALESCE(cache_write_input_tokens, 0)
                                  ELSE COALESCE(input_tokens, 0) END) billed,
                         SUM(output_tokens) out, SUM(reasoning_output_tokens) rsn, SUM(cost_usd) cost
                  FROM attempt_usage GROUP BY attempt_id) u ON u.attempt_id = a.id
       WHERE a.arc_id = ?
       GROUP BY a.role, a.cli
       ORDER BY wall_ms DESC`,
    ).all(Date.now(), arcId) as any
  }

  /** Exact provider receipts for an arc. Null means the CLI did not report it. */
  usageFor(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM attempt_usage WHERE arc_id = ? ORDER BY recorded_at, id`,
    ).all(arcId) as any
  }

  usageForAttempt(attemptId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM attempt_usage WHERE attempt_id = ? ORDER BY recorded_at, id`,
    ).all(attemptId) as any
  }

  // -- criteria: the harness grades, the agent never does --------------------

  /**
   * An agent may CLAIM any tier. We record the tier the stored evidence
   * supports — a `observed` with no artifact lands at `claimed`.
   */
  promoteCriterion(
    arcId: string,
    taskId: string,
    critId: string,
    claimed: ClaimTier,
    evidence: string,
    evidenceArtifactId?: string,
  ): ClaimTier {
    const row = this.db
      .prepare(`SELECT tier, proof_kind FROM criterion WHERE arc_id = ? AND task_id = ? AND id = ?`)
      .get(arcId, taskId, critId) as { tier: ClaimTier; proof_kind: string } | undefined
    if (!row) return 'unproven'

    const artifact = evidenceArtifactId
      ? this.db.prepare(`SELECT arc_id, kind FROM artifact WHERE id = ?`).get(evidenceArtifactId) as
          | { arc_id: string; kind: string }
          | undefined
      : undefined
    const validArtifact = artifact?.arc_id === arcId ? artifact : undefined

    let granted: ClaimTier = claimed === 'unproven' ? 'unproven' : 'claimed'
    if (claimed === 'checked' || claimed === 'observed') {
      const supportsChecked =
        (row.proof_kind === 'command' && validArtifact?.kind === 'criterion-proof') ||
        (row.proof_kind === 'agent-review' && validArtifact?.kind === 'review-verdict') ||
        (row.proof_kind === 'artifact' && validArtifact?.kind === 'artifact-observation') ||
        (row.proof_kind === 'human-observation' && validArtifact?.kind === 'human-observation')
      if (supportsChecked) {
        granted = claimed === 'observed' && validArtifact?.kind === 'human-observation'
          ? 'observed'
          : 'checked'
      }
    } else if (claimed === 'waived' && validArtifact?.kind === 'human-waiver') {
      granted = 'waived'
    }

    // Never demote: a criterion proven by a gate stays proven.
    if (TIER_RANK[granted] <= TIER_RANK[row.tier]) return row.tier

    this.db
      .prepare(
        `UPDATE criterion SET tier = ?, evidence = ?, evidence_artifact_id = ?, proved_at = ?
         WHERE arc_id = ? AND task_id = ? AND id = ?`,
      )
      .run(granted, evidence, evidenceArtifactId ?? null, Date.now(), arcId, taskId, critId)
    this.appendEvent(arcId, 'criterion.tier', { id: critId, claimed, granted }, taskId)
    return granted
  }

  criteriaFor(arcId: string, taskId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM criterion WHERE arc_id = ? AND task_id = ?`).all(arcId, taskId) as any
  }

  allCriteria(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM criterion WHERE arc_id = ?`).all(arcId) as any
  }

  /** A task is done only when every criterion reached its OWN required tier. */
  unmetCriteria(arcId: string, taskId: string): Array<Record<string, any>> {
    return this.criteriaFor(arcId, taskId).filter(
      (c) => TIER_RANK[c.tier as ClaimTier] < TIER_RANK[c.required_tier as ClaimTier],
    )
  }

  // -- artifacts (in OUR store, never in the subject repo) -------------------

  putArtifact(arcId: string, kind: string, content: string, attemptId?: string): string {
    const id = randomUUID()
    const sha = createHash('sha256').update(content).digest('hex')
    const path = join(this.root, 'artifacts', `${id}.${kind}.txt`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    this.db
      .prepare(
        `INSERT INTO artifact (id, arc_id, attempt_id, kind, path, sha256, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, arcId, attemptId ?? null, kind, path, sha, Buffer.byteLength(content), Date.now())
    return id
  }

  artifactPath(id: string): string | undefined {
    const r = this.db.prepare(`SELECT path FROM artifact WHERE id = ?`).get(id) as { path: string } | undefined
    return r?.path
  }

  artifactInfo(id: string): Record<string, any> | undefined {
    return this.db.prepare(`SELECT * FROM artifact WHERE id = ?`).get(id) as any
  }

  // -- findings, gates, pending ops -----------------------------------------

  addFinding(f: {
    arcId: string
    attemptId?: string
    taskId?: string
    kind: string
    severity?: string
    text: string
    affects?: string[]
  }): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO finding (id, arc_id, attempt_id, task_id, kind, severity, text, affects_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.arcId, f.attemptId ?? null, f.taskId ?? null, f.kind, f.severity ?? 'low', f.text, JSON.stringify(f.affects ?? []), Date.now())
    this.appendEvent(f.arcId, 'finding', { kind: f.kind, text: f.text, affects: f.affects ?? [] }, f.taskId)
    return id
  }

  attachFindingEvidence(findingId: string, evidence: {
    artifactId: string
    command: string
    exitCode: number | null
    // 'inconclusive' is a THIRD outcome: the command could not run, so it
    // refuted nothing. Collapsing it into 'fail' is what deleted evidence.
    verdict: 'pass' | 'fail' | 'inconclusive'
    caveat?: string
  }): void {
    this.db.prepare(
      `INSERT INTO finding_evidence (finding_id, artifact_id, command, exit_code, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(findingId, evidence.artifactId, evidence.command, evidence.exitCode,
          evidence.caveat ? `${evidence.verdict} (${evidence.caveat})` : evidence.verdict, Date.now())
  }

  evidenceForFinding(findingId: string): Array<Record<string, any>> {
    return this.db.prepare(
      `SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at`,
    ).all(findingId) as any
  }

  /**
   * A spec amendment: something a FINISHED task learned that changes what a
   * not-yet-dispatched task should do.
   *
   * Stored rather than patched into the plan file, so it survives a crash and
   * a resume. The brief compiler injects these at Tier 0 — they are spec-level
   * and must never be dropped to make a brief fit.
   */
  addAmendment(arcId: string, taskId: string, text: string, fromTaskId: string): void {
    this.addFinding({
      arcId, taskId, kind: 'amendment', severity: 'high',
      text: `[from ${fromTaskId}] ${text}`, affects: [taskId],
    })
  }

  amendmentsFor(arcId: string, taskId: string): Array<Record<string, any>> {
    return this.findingsFor(arcId).filter((f) => f.kind === 'amendment' && f.task_id === taskId)
  }

  findingsFor(arcId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM finding WHERE arc_id = ? ORDER BY created_at`).all(arcId) as any
  }

  /** Artifact metadata for an arc, newest first; content stays on disk. */
  artifactsFor(arcId: string, kind?: string): Array<Record<string, any>> {
    return kind
      ? this.db.prepare(`SELECT id, kind, attempt_id, bytes, created_at FROM artifact WHERE arc_id = ? AND kind = ? ORDER BY created_at DESC`).all(arcId, kind) as any
      : this.db.prepare(`SELECT id, kind, attempt_id, bytes, created_at FROM artifact WHERE arc_id = ? ORDER BY created_at DESC`).all(arcId) as any
  }

  recordGate(g: {
    arcId: string
    taskId?: string
    attemptId?: string
    name: string
    command: string
    proves: string
    exitCode: number | null
    baseSha: string
    verdict: 'pass' | 'fail' | 'baseline'
    signature?: string
    artifactId?: string
    durationMs?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO gate_run (id, arc_id, task_id, attempt_id, name, command, proves, exit_code, base_sha, verdict, signature, artifact_id, duration_ms, ran_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), g.arcId, g.taskId ?? null, g.attemptId ?? null, g.name, g.command, g.proves,
        g.exitCode, g.baseSha, g.verdict, g.signature ?? null, g.artifactId ?? null,
        g.durationMs ?? null, Date.now(),
      )
    this.appendEvent(g.arcId, 'gate', { name: g.name, verdict: g.verdict, exitCode: g.exitCode, proves: g.proves }, g.taskId, g.attemptId)
  }

  gatesFor(arcId: string, taskId: string): Array<Record<string, any>> {
    return this.db.prepare(`SELECT * FROM gate_run WHERE arc_id = ? AND task_id = ? ORDER BY ran_at`).all(arcId, taskId) as any
  }

  addPendingOp(arcId: string, taskId: string, kind: string, description: string, blocking: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pending_op (id, arc_id, task_id, kind, description, blocking, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(randomUUID(), arcId, taskId, kind, description, blocking ? 1 : 0, Date.now())
    this.appendEvent(arcId, 'pending-op', { kind, description, blocking }, taskId)
  }

  openBlockingOps(arcId: string): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT * FROM pending_op WHERE arc_id = ? AND status = 'open' AND blocking = 1`)
      .all(arcId) as any
  }
}
