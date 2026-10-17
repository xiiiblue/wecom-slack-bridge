import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const WORKFLOW_DEFAULTS = Object.freeze({ minimumQuota: 5, scanIntervalMs: 600_000, quotaMaxAgeMs: 60_000, maxSessionMs: 604_800_000 });
export const WORKFLOW_OPERATIONS = Object.freeze(['edit-code', 'run-tests', 'open-draft-pr']);
const requireThat = (condition, code) => { if (!condition) throw new Error(code); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const operationBundle = operations => {
  requireThat(Array.isArray(operations) && operations.length > 0 && new Set(operations).size === operations.length && [...operations].every(op => WORKFLOW_OPERATIONS.includes(op)), 'invalid_operations');
  return JSON.stringify([...operations].sort());
};
const nonempty = s => typeof s === 'string' && s.trim().length > 0;

/** Dormant persistence/gating primitive, NOT a scanner or executor.
 * Callers must authenticate actor before passing it here; an actor string is not
 * authentication. executionReady must come from a trusted adapter capability check,
 * never an issue body or inbound message. Quota is an adapter-supplied remaining
 * percentage (0..100): the minimum remaining across all applicable finite rate-limit
 * windows, observed against the same trusted millisecond clock. The caller must
 * verify provider/account provenance; user-supplied quota is never authoritative.
 * Every queued operation carries the generation returned by status/startAuto/setManual.
 * No bridge review record is read or upgraded into an execution grant.
 */
export class WorkflowControl {
  constructor(dir, { owner, repository, executionReady = false, now = Date.now, quotaMaxAgeMs = WORKFLOW_DEFAULTS.quotaMaxAgeMs } = {}) {
    requireThat(nonempty(owner) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'invalid_configuration');
    requireThat(typeof executionReady === 'boolean' && typeof now === 'function' && positive(quotaMaxAgeMs), 'invalid_configuration');
    this.owner = owner; this.repository = repository; this.executionReady = executionReady;
    this.now = now; this.quotaMaxAgeMs = quotaMaxAgeMs; this.instance = randomUUID();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'workflow.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS workflow_control (
          id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, repository TEXT NOT NULL,
          mode TEXT NOT NULL, generation INTEGER NOT NULL, deadline INTEGER, controller TEXT,
          minimum_quota REAL NOT NULL, scan_interval INTEGER NOT NULL, last_scan INTEGER);
        CREATE TABLE IF NOT EXISTS workflow_proposals (
          repo TEXT NOT NULL, issue_id TEXT NOT NULL, issue_number INTEGER NOT NULL,
          revision INTEGER NOT NULL, scope TEXT NOT NULL, operations TEXT NOT NULL,
          PRIMARY KEY(repo,issue_id), UNIQUE(repo,issue_number));
        CREATE TABLE IF NOT EXISTS workflow_grants (
          id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue_id TEXT NOT NULL,
          revision INTEGER NOT NULL, scope TEXT NOT NULL, operations TEXT NOT NULL, actor TEXT NOT NULL,
          expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(repo,issue_id,revision));
        CREATE TABLE IF NOT EXISTS workflow_claims (
          id TEXT PRIMARY KEY, slot INTEGER UNIQUE CHECK(slot=1), grant_id TEXT UNIQUE NOT NULL,
          repo TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL,
          scope TEXT NOT NULL, operations TEXT NOT NULL, instance TEXT NOT NULL, status TEXT NOT NULL,
          stop_mode TEXT, created INTEGER NOT NULL, review_note TEXT);`);
      this.tx(() => {
        this.run(`INSERT OR IGNORE INTO workflow_control VALUES (1,?,?, 'manual',0,NULL,NULL,?,?,NULL)`, owner, repository, WORKFLOW_DEFAULTS.minimumQuota, WORKFLOW_DEFAULTS.scanIntervalMs);
        const s = this.control();
        requireThat(s.owner === owner && s.repository === repository, 'configuration_identity_mismatch');
      });
    } catch (e) { this.db.close(); throw e; }
  }
  // Internal database helpers; this module is not a security boundary against code
  // with access to this database or the authenticated adapter process.
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  auth(actor) { requireThat(actor === this.owner, 'unauthorized'); }
  control() { return this.get('SELECT * FROM workflow_control WHERE id=1'); }
  expire(now) {
    const s = this.control();
    if (s.mode === 'auto' && now >= s.deadline) {
      this.run("UPDATE workflow_control SET mode='stopped', generation=generation+1, deadline=NULL WHERE id=1");
      this.run("UPDATE workflow_claims SET stop_mode='checkpoint' WHERE slot=1 AND stop_mode IS NULL");
    }
  }
  status() {
    return this.tx(() => {
      this.expire(this.now());
      const claim = this.get('SELECT * FROM workflow_claims WHERE slot=1') ?? null;
      const state = this.control();
      return { ...state, executionReady: this.executionReady, claim,
        autoResumeRequiresApproval: state.mode === 'auto' && state.controller !== this.instance,
        recoveryRequired: !!claim && (claim.instance !== this.instance || claim.status === 'needs_review') };
    });
  }
  startAuto({ actor, deadline, minimumQuota = WORKFLOW_DEFAULTS.minimumQuota, scanIntervalMs = WORKFLOW_DEFAULTS.scanIntervalMs }) {
    this.auth(actor); const now = this.now();
    requireThat(positive(deadline) && deadline > now && deadline - now <= WORKFLOW_DEFAULTS.maxSessionMs, 'invalid_deadline');
    requireThat(Number.isFinite(minimumQuota) && minimumQuota >= 5 && minimumQuota < 100 && positive(scanIntervalMs) && scanIntervalMs >= WORKFLOW_DEFAULTS.scanIntervalMs, 'invalid_session_limits');
    return this.tx(() => {
      requireThat(!this.get('SELECT id FROM workflow_claims WHERE slot=1'), 'active_claim');
      this.run("UPDATE workflow_control SET mode='auto', generation=generation+1, deadline=?, controller=?, minimum_quota=?, scan_interval=?, last_scan=NULL WHERE id=1", deadline, this.instance, minimumQuota, scanIntervalMs);
      return this.control();
    });
  }
  setManual({ actor }) {
    this.auth(actor);
    return this.tx(() => {
      requireThat(!this.get('SELECT id FROM workflow_claims WHERE slot=1'), 'active_claim');
      this.run("UPDATE workflow_control SET mode='manual', generation=generation+1, deadline=NULL, minimum_quota=5, last_scan=NULL WHERE id=1");
      return this.control();
    });
  }
  stop({ actor, mode = 'checkpoint' }) {
    this.auth(actor); requireThat(['checkpoint', 'finish-current'].includes(mode), 'invalid_stop_mode');
    return this.tx(() => {
      this.run("UPDATE workflow_control SET mode='stopped', generation=generation+1, deadline=NULL WHERE id=1");
      // A later finish-current request must not weaken a prior checkpoint request.
      this.run("UPDATE workflow_claims SET stop_mode=CASE WHEN stop_mode='checkpoint' THEN stop_mode ELSE ? END WHERE slot=1", mode);
      return this.control();
    });
  }
  registerProposal({ actor, repo, issueId, issueNumber, revision, scope, operations }) {
    this.auth(actor);
    requireThat(repo === this.repository && typeof issueId === 'string' && /^[1-9][0-9]{0,19}$/.test(issueId) && positive(issueNumber) && positive(revision) && nonempty(scope), 'invalid_proposal');
    const bundle = operationBundle(operations);
    return this.tx(() => {
      const old = this.get('SELECT * FROM workflow_proposals WHERE repo=? AND issue_id=?', repo, issueId);
      requireThat(!old || old.issue_number === issueNumber, 'identity_mismatch');
      requireThat(!old || revision > old.revision, 'stale_revision');
      requireThat(!this.get('SELECT id FROM workflow_claims WHERE slot=1 AND repo=? AND issue_id=?', repo, issueId), 'active_claim');
      this.run(`INSERT INTO workflow_proposals VALUES (?,?,?,?,?,?) ON CONFLICT(repo,issue_id) DO UPDATE SET revision=excluded.revision, scope=excluded.scope, operations=excluded.operations`, repo, issueId, issueNumber, revision, scope, bundle);
    });
  }
  grantExecution({ actor, repo, issueId, revision, scope, operations, kind, decision_record_only, expires }) {
    this.auth(actor);
    requireThat(kind === 'execution' && decision_record_only === false, 'explicit_execution_grant_required');
    requireThat(positive(expires) && expires > this.now(), 'invalid_grant_expiry');
    const bundle = operationBundle(operations);
    return this.tx(() => {
      const p = this.get('SELECT * FROM workflow_proposals WHERE repo=? AND issue_id=?', repo, issueId);
      requireThat(p && p.revision === revision && p.scope === scope && p.operations === bundle, 'proposal_mismatch');
      const id = randomUUID();
      this.run('INSERT INTO workflow_grants(id,repo,issue_id,revision,scope,operations,actor,expires) VALUES (?,?,?,?,?,?,?,?)', id, repo, issueId, revision, scope, bundle, actor, expires);
      return id;
    });
  }
  revokeGrant({ actor, grantId }) {
    this.auth(actor);
    return this.tx(() => {
      requireThat(this.get('SELECT id FROM workflow_grants WHERE id=?', grantId), 'invalid_execution_grant');
      this.run('UPDATE workflow_grants SET revoked=1 WHERE id=?', grantId);
      this.run("UPDATE workflow_claims SET stop_mode='checkpoint' WHERE slot=1 AND grant_id=?", grantId);
    });
  }
  gate({ generation, quota }, now) {
    const s = this.control();
    requireThat(this.executionReady, 'adapter_not_ready');
    requireThat(s.generation === generation, 'stale_generation');
    requireThat(s.mode !== 'stopped', 'workflow_stopped');
    requireThat(s.mode !== 'auto' || s.controller === this.instance, 'auto_restart_requires_approval');
    this.checkQuota(quota, now, s.minimum_quota);
    return s;
  }
  checkQuota(quota, now, minimumQuota) {
    requireThat(quota && Number.isFinite(quota.remainingPercent) && quota.remainingPercent >= 0 && quota.remainingPercent <= 100 && Number.isSafeInteger(quota.observedAt) && quota.observedAt <= now && now - quota.observedAt <= this.quotaMaxAgeMs, 'quota_unknown_or_stale');
    requireThat(quota.remainingPercent > minimumQuota, 'quota_too_low');
  }
  // Commit a fail-closed automatic pause even though the operation is rejected.
  // Fresh quota later does not resume the session; explicit startAuto is required.
  guarded(fn) {
    const result = this.tx(() => {
      try { return { value: fn() }; } catch (error) {
        if (!['quota_unknown_or_stale', 'quota_too_low'].includes(error.message)) throw error;
        if (this.control().mode === 'auto') {
          this.run("UPDATE workflow_control SET mode='stopped', generation=generation+1, deadline=NULL WHERE id=1");
        }
        this.run("UPDATE workflow_claims SET stop_mode='checkpoint' WHERE slot=1");
        return { error };
      }
    });
    if (result.error) throw result.error;
    return result.value;
  }
  /** Reserves permission for one scan; performs no I/O or actual scanning. */
  reserveScan({ actor, generation, quota }) {
    this.auth(actor); this.status(); // Persist expiry even when the later gate rejects.
    return this.guarded(() => {
      const now = this.now(), s = this.gate({ generation, quota }, now);
      requireThat(s.mode === 'auto' && now < s.deadline, 'auto_session_required');
      requireThat(!this.get('SELECT id FROM workflow_claims WHERE slot=1'), 'active_claim');
      requireThat(s.last_scan === null || now - s.last_scan >= s.scan_interval, 'scan_not_due');
      this.run('UPDATE workflow_control SET last_scan=? WHERE id=1', now);
      return { generation: s.generation, deadline: s.deadline };
    });
  }
  /** Atomically claims a grant once. Manual dispatch uses every safety gate too. */
  dispatch({ actor, generation, quota, grantId, automatic = false }) {
    this.auth(actor); requireThat(typeof automatic === 'boolean', 'invalid_dispatch'); this.status();
    return this.guarded(() => {
      const now = this.now(), s = this.gate({ generation, quota }, now);
      requireThat(s.mode !== 'auto' || now < s.deadline, 'session_expired');
      requireThat(!automatic || s.mode === 'auto', 'auto_session_required');
      requireThat(!this.get('SELECT id FROM workflow_claims WHERE slot=1'), 'active_claim');
      const g = this.get('SELECT * FROM workflow_grants WHERE id=?', grantId);
      requireThat(g && !g.used && !g.revoked && g.actor === actor && now < g.expires, 'invalid_execution_grant');
      const p = this.get('SELECT * FROM workflow_proposals WHERE repo=? AND issue_id=?', g.repo, g.issue_id);
      requireThat(p && p.revision === g.revision && p.scope === g.scope && p.operations === g.operations, 'superseded_execution_grant');
      const id = randomUUID();
      this.run("INSERT INTO workflow_claims(id,slot,grant_id,repo,issue_id,revision,scope,operations,instance,status,created) VALUES (?,1,?,?,?,?,?,?,?,'claimed',?)", id, g.id, g.repo, g.issue_id, g.revision, g.scope, g.operations, this.instance, now);
      this.run('UPDATE workflow_grants SET used=1 WHERE id=?', g.id);
      return this.get('SELECT * FROM workflow_claims WHERE id=?', id);
    });
  }
  /** Required immediately before EVERY adapter step, even after dispatch. This
   * grants only a member of the stored operation bundle; free-text scope is descriptive, not a sandbox.
   * The adapter must enforce the approved file/repository scope and never deploy.
   * A synchronous check cannot cancel an already-running external side effect;
   * stop is observed at the next checkpoint, not an OS-level interruption. */
  authorizeStep({ actor, claimId, operation, quota }) {
    this.auth(actor); this.status();
    return this.guarded(() => {
      const now = this.now(), s = this.control();
      requireThat(this.executionReady, 'adapter_not_ready');
      const c = this.get('SELECT * FROM workflow_claims WHERE id=? AND slot=1', claimId);
      requireThat(c && c.instance === this.instance && c.status === 'claimed', 'claim_needs_review');
      requireThat(c.stop_mode !== 'checkpoint', 'checkpoint_requested');
      requireThat(s.mode !== 'stopped' || c.stop_mode === 'finish-current', 'workflow_stopped');
      requireThat(s.mode !== 'auto' || now < s.deadline, 'session_expired');
      requireThat(WORKFLOW_OPERATIONS.includes(operation) && JSON.parse(c.operations).includes(operation), 'operation_not_granted');
      const g = this.get('SELECT * FROM workflow_grants WHERE id=?', c.grant_id);
      requireThat(g && g.used === 1 && !g.revoked && now < g.expires, 'invalid_execution_grant');
      this.checkQuota(quota, now, s.minimum_quota);
      return { claimId: c.id, repo: c.repo, issueId: c.issue_id, revision: c.revision, scope: c.scope, operation };
    });
  }
  /** A trusted adapter reports completion, checkpoint, or uncertainty. Only normal
   * completion frees the slot; checkpoint/failed work requires explicit review. */
  finish({ actor, claimId, outcome }) {
    this.auth(actor); requireThat(['completed', 'checkpoint', 'failed'].includes(outcome), 'invalid_outcome');
    return this.tx(() => {
      const c = this.get('SELECT * FROM workflow_claims WHERE id=? AND slot=1', claimId);
      requireThat(c && c.instance === this.instance && c.status === 'claimed', 'claim_needs_review');
      this.run('UPDATE workflow_claims SET status=?, slot=? WHERE id=?', outcome === 'completed' ? 'completed' : 'needs_review', outcome === 'completed' ? null : 1, claimId);
    });
  }
  /** Explicit human reconciliation after verifying any former worker has stopped.
   * Releasing a claim never reuses its grant or resumes an automatic session. */
  resolveClaim({ actor, claimId, note, workerStopped }) {
    this.auth(actor); requireThat(workerStopped === true && nonempty(note), 'review_required');
    return this.tx(() => {
      requireThat(this.get('SELECT id FROM workflow_claims WHERE id=? AND slot=1', claimId), 'claim_not_active');
      this.run("UPDATE workflow_claims SET status='reviewed', slot=NULL, review_note=? WHERE id=?", note, claimId);
      this.run("UPDATE workflow_control SET mode='stopped', generation=generation+1, deadline=NULL WHERE id=1");
    });
  }
  close() { this.db.close(); } // Never releases claims or enables automation.
}
