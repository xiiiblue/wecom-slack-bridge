import test from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowControl, WORKFLOW_DEFAULTS } from '../src/workflow-control.js';

function fixture(t, ready = true) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-control-'));
  let time = 1_800_000_000_000;
  const connections = [];
  const open = (extra = {}) => {
    const c = new WorkflowControl(dir, { owner: 'owner', repository: 'org/repo', executionReady: ready, now: () => time, ...extra });
    connections.push(c); return c;
  };
  t.after(() => { for (const c of connections) { try { c.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  const c = open();
  const proposal = { actor: 'owner', repo: 'org/repo', issueId: '123', issueNumber: 7, revision: 1, scope: 'Only update unit tests', operations: ['edit-code'] };
  const grant = (p = proposal) => { c.registerProposal(p); return c.grantExecution({ ...p, kind: 'execution', decision_record_only: false, expires: time + 3_600_000 }); };
  const args = (grantId, extra = {}) => ({ actor: 'owner', generation: c.status().generation, quota: { remainingPercent: 50, observedAt: time }, grantId, ...extra });
  return { dir, c, open, proposal, grant, args, now: () => time, advance: ms => { time += ms; } };
}

test('new database is durable manual; readiness defaults to false; configuration is pinned', t => {
  const f = fixture(t, false);
  assert.equal(f.c.status().mode, 'manual');
  assert.equal(f.c.status().minimum_quota, 5);
  assert.equal(f.c.status().scan_interval, 600_000);
  const id = f.grant();
  assert.throws(() => f.c.dispatch(f.args(id)), /adapter_not_ready/);
  assert.equal(f.open().status().mode, 'manual');
  assert.throws(() => f.open({ repository: 'other/repo' }), /configuration_identity_mismatch/);
  assert.throws(() => f.open({ owner: 'impostor' }), /configuration_identity_mismatch/);
});

test('auto sessions need explicit bounded deadline and conservative limits; scans are gated and spaced', t => {
  const f = fixture(t), { c } = f;
  assert.throws(() => c.startAuto({ actor: 'owner' }), /invalid_deadline/);
  assert.throws(() => c.startAuto({ actor: 'owner', deadline: f.now() + WORKFLOW_DEFAULTS.maxSessionMs + 1 }), /invalid_deadline/);
  assert.throws(() => c.startAuto({ actor: 'owner', deadline: f.now() + 1000, minimumQuota: 4 }), /invalid_session_limits/);
  assert.throws(() => c.startAuto({ actor: 'owner', deadline: f.now() + 1000, scanIntervalMs: 1 }), /invalid_session_limits/);
  assert.throws(() => c.reserveScan(f.args()), /auto_session_required/);
  c.startAuto({ actor: 'owner', deadline: f.now() + 1_800_000 });
  c.reserveScan(f.args());
  assert.throws(() => c.reserveScan(f.args()), /scan_not_due/);
  f.advance(600_000); c.reserveScan(f.args());
  f.advance(1_200_000);
  assert.throws(() => c.reserveScan(f.args()), /workflow_stopped/);
  assert.equal(f.open().status().mode, 'stopped');
});

test('manual dispatch requires authenticated owner, execution grant, fresh quota, and a single claim', t => {
  const f = fixture(t), id = f.grant();
  assert.throws(() => f.c.dispatch(f.args(id, { actor: 'other' })), /unauthorized/);
  assert.throws(() => f.c.dispatch(f.args(id, { automatic: true })), /auto_session_required/);
  for (const quota of [undefined, {}, { remainingPercent: 90, observedAt: f.now() - 60_001 }, { remainingPercent: 90, observedAt: f.now() + 1 }, { remainingPercent: 101, observedAt: f.now() }]) {
    assert.throws(() => f.c.dispatch(f.args(id, { quota })), /quota_unknown_or_stale/);
  }
  for (const remainingPercent of [0, 5]) assert.throws(() => f.c.dispatch(f.args(id, { quota: { remainingPercent, observedAt: f.now() } })), /quota_too_low/);
  assert.throws(() => f.c.dispatch(f.args('record-only-review-id')), /invalid_execution_grant/);
  const claim = f.c.dispatch(f.args(id));
  assert.equal(claim.repo, 'org/repo'); assert.equal(claim.issue_id, '123'); assert.equal(claim.revision, 1);
  assert.throws(() => f.c.dispatch(f.args(id)), /active_claim/);
  f.c.finish({ actor: 'owner', claimId: claim.id, outcome: 'completed' });
  assert.throws(() => f.c.dispatch(f.args(id)), /invalid_execution_grant/);
});

test('record-only approvals cannot become grants, and revisions and identity are immutable', t => {
  const f = fixture(t), { c, proposal: p } = f;
  c.registerProposal(p);
  for (const extra of [{ kind: 'record-only', decision_record_only: true }, { kind: 'execution', decision_record_only: true }, { kind: 'execution' }]) {
    assert.throws(() => c.grantExecution({ ...p, expires: f.now() + 1000, ...extra }), /explicit_execution_grant_required/);
  }
  const id = c.grantExecution({ ...p, kind: 'execution', decision_record_only: false, expires: f.now() + 1000 });
  assert.throws(() => c.registerProposal(p), /stale_revision/);
  assert.throws(() => c.registerProposal({ ...p, issueNumber: 8, revision: 2 }), /identity_mismatch/);
  assert.throws(() => c.registerProposal({ ...p, issueId: '999' }), /UNIQUE constraint/);
  assert.throws(() => c.registerProposal({ ...p, repo: 'other/repo' }), /invalid_proposal/);
  c.registerProposal({ ...p, revision: 2 });
  assert.throws(() => c.dispatch(f.args(id)), /superseded_execution_grant/);
});

for (const mode of ['checkpoint', 'finish-current']) test(`stop ${mode} immediately fences queued scans and all claims`, t => {
  const f = fixture(t), id = f.grant();
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 100_000 });
  const queued = f.args(id, { automatic: true });
  const claim = f.c.dispatch(queued);
  f.c.stop({ actor: 'owner', mode });
  assert.equal(f.c.status().claim.stop_mode, mode);
  assert.throws(() => f.c.reserveScan(queued), /stale_generation/);
  assert.throws(() => f.c.dispatch(queued), /stale_generation/);
  assert.throws(() => f.c.dispatch(f.args(id)), /workflow_stopped/);
  f.c.finish({ actor: 'owner', claimId: claim.id, outcome: mode === 'checkpoint' ? 'checkpoint' : 'completed' });
  assert.equal(f.c.status().mode, 'stopped');
  assert.equal(f.c.status().claim?.status ?? null, mode === 'checkpoint' ? 'needs_review' : null);
});

test('mode changes invalidate queued work, and checkpoint cannot be weakened', t => {
  const f = fixture(t), id = f.grant(), queued = f.args(id);
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 1000 });
  assert.throws(() => f.c.dispatch(queued), /stale_generation/);
  const claim = f.c.dispatch(f.args(id));
  assert.throws(() => f.c.setManual({ actor: 'owner' }), /active_claim/);
  f.c.stop({ actor: 'owner' }); f.c.stop({ actor: 'owner', mode: 'finish-current' });
  assert.equal(f.c.status().claim.stop_mode, 'checkpoint');
  assert.throws(() => f.c.registerProposal({ ...f.proposal, revision: 2 }), /active_claim/);
  f.c.resolveClaim({ actor: 'owner', claimId: claim.id, workerStopped: true, note: 'Verified no worker remains' });
  assert.equal(f.c.status().mode, 'stopped');
  f.c.setManual({ actor: 'owner' }); assert.equal(f.c.status().mode, 'manual');
});

test('independent connections preserve the occupied slot; restart never frees it', t => {
  const f = fixture(t), id = f.grant(), second = f.open();
  const claim = f.c.dispatch(f.args(id));
  assert.throws(() => second.dispatch(f.args(id)), /active_claim/);
  assert.equal(second.status().claim.id, claim.id);
  assert.equal(second.status().recoveryRequired, true);
  f.c.close();
  const reopened = f.open();
  assert.equal(reopened.status().claim.id, claim.id);
  assert.throws(() => reopened.dispatch({ actor: 'owner', generation: 0, quota: { remainingPercent: 50, observedAt: f.now() }, grantId: id }), /active_claim/);
  assert.throws(() => reopened.finish({ actor: 'owner', claimId: claim.id, outcome: 'completed' }), /claim_needs_review/);
  assert.throws(() => reopened.resolveClaim({ actor: 'owner', claimId: claim.id, note: 'Unchecked' }), /review_required/);
  reopened.resolveClaim({ actor: 'owner', claimId: claim.id, workerStopped: true, note: 'Worker stopped; changes inspected' });
  assert.equal(reopened.status().claim, null); assert.equal(reopened.status().mode, 'stopped');
});

test('deadline expiry requests checkpoint for the active claim; expired grants fail closed', t => {
  const f = fixture(t), id = f.grant();
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 1000 });
  const claim = f.c.dispatch(f.args(id, { automatic: true }));
  f.advance(1000);
  assert.equal(f.c.status().mode, 'stopped'); assert.equal(f.c.status().claim.stop_mode, 'checkpoint');
  f.c.finish({ actor: 'owner', claimId: claim.id, outcome: 'failed' });
  assert.equal(f.c.status().recoveryRequired, true);
});

test('grant expiry is enforced even with fresh quota', t => {
  const f = fixture(t), id = f.grant(); f.advance(3_600_000);
  assert.throws(() => f.c.dispatch(f.args(id)), /invalid_execution_grant/);
});

for (const quotaKind of ['low', 'unknown']) test(`auto ${quotaKind} quota pauses durably and never self-resumes`, t => {
  const f = fixture(t), id = f.grant();
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 100_000 });
  const quota = quotaKind === 'low' ? { remainingPercent: 5, observedAt: f.now() } : undefined;
  assert.throws(() => f.c.dispatch(f.args(id, { quota })), /quota_/);
  assert.equal(f.c.status().mode, 'stopped');
  assert.equal(f.open().status().mode, 'stopped');
  assert.throws(() => f.c.dispatch(f.args(id)), /workflow_stopped/);
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 100_000 });
  assert.ok(f.c.dispatch(f.args(id)).id);
});

test('concurrent worker connections race for exactly one durable claim', async t => {
  const f = fixture(t), grantId = f.grant();
  const url = new URL('../src/workflow-control.js', import.meta.url).href;
  const workers = [1, 2].map(() => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { WorkflowControl } = await import(workerData.url);
      const c = new WorkflowControl(workerData.dir, { owner: 'owner', repository: 'org/repo', executionReady: true, now: () => workerData.now });
      parentPort.once('message', () => {
        try { const claim = c.dispatch({ actor: 'owner', generation: 0, grantId: workerData.grantId, quota: { remainingPercent: 50, observedAt: workerData.now } }); parentPort.postMessage({ claim: claim.id }); }
        catch (e) { parentPort.postMessage({ error: e.message }); }
        finally { c.close(); }
      });
      parentPort.postMessage({ ready: true });
    })().catch(e => { throw e; });
  `, { eval: true, workerData: { url, dir: f.dir, grantId, now: f.now() } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  await Promise.all(workers.map(w => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); })));
  const results = workers.map(w => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); }));
  workers.forEach(w => w.postMessage('claim'));
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(x => x.claim).length, 1);
  assert.equal(outcomes.filter(x => x.error === 'active_claim').length, 1);
  assert.equal(f.c.status().claim.id, outcomes.find(x => x.claim).claim);
});

test('one execution grant per revision; operation must be explicitly supported', t => {
  const f = fixture(t), id = f.grant();
  assert.throws(() => f.c.grantExecution({ ...f.proposal, kind: 'execution', decision_record_only: false, expires: f.now() + 1000 }), /UNIQUE constraint/);
  assert.throws(() => f.c.registerProposal({ ...f.proposal, revision: 2, operations: ['deploy'] }), /invalid_operations/);
  const claim = f.c.dispatch(f.args(id));
  const step = { actor: 'owner', claimId: claim.id, operation: 'edit-code', quota: f.args().quota };
  assert.equal(f.c.authorizeStep(step).operation, 'edit-code');
  assert.throws(() => f.c.authorizeStep({ ...step, operation: 'deploy' }), /operation_not_granted/);
  assert.throws(() => f.c.authorizeStep({ ...step, operation: 'run-tests' }), /operation_not_granted/);
});

test('step gate honors checkpoint and finish-current but never overrides low quota', t => {
  const f = fixture(t), id = f.grant();
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 100_000 });
  const claim = f.c.dispatch(f.args(id));
  const step = { actor: 'owner', claimId: claim.id, operation: 'edit-code', quota: f.args().quota };
  f.c.stop({ actor: 'owner', mode: 'finish-current' });
  assert.ok(f.c.authorizeStep(step));
  assert.throws(() => f.c.authorizeStep({ ...step, quota: { remainingPercent: 5, observedAt: f.now() } }), /quota_too_low/);
  assert.equal(f.c.status().claim.stop_mode, 'checkpoint');
  assert.throws(() => f.c.authorizeStep(step), /checkpoint_requested/);
});

test('revocation blocks future dispatch and requests checkpoint for a claimed grant', t => {
  const f = fixture(t), id = f.grant();
  f.c.revokeGrant({ actor: 'owner', grantId: id });
  assert.throws(() => f.c.dispatch(f.args(id)), /invalid_execution_grant/);
  const id2 = f.grant({ ...f.proposal, revision: 2 });
  const claim = f.c.dispatch(f.args(id2));
  f.c.revokeGrant({ actor: 'owner', grantId: id2 });
  assert.throws(() => f.c.authorizeStep({ actor: 'owner', claimId: claim.id, operation: 'edit-code', quota: f.args().quota }), /checkpoint_requested/);
});

test('idle auto session cannot resume from a new controller without explicit start', t => {
  const f = fixture(t), id = f.grant();
  f.c.startAuto({ actor: 'owner', deadline: f.now() + 3 * 86_400_000 });
  const other = f.open(), args = f.args(id, { automatic: true });
  assert.equal(other.status().autoResumeRequiresApproval, true);
  assert.throws(() => other.dispatch(args), /auto_restart_requires_approval/);
  assert.throws(() => other.reserveScan(args), /auto_restart_requires_approval/);
  other.startAuto({ actor: 'owner', deadline: f.now() + 3 * 86_400_000 });
  assert.ok(other.dispatch({ ...args, generation: other.status().generation }));
});

test('step gate rechecks expiry and adapter readiness after claim', t => {
  const f = fixture(t), id = f.grant(), claim = f.c.dispatch(f.args(id));
  const step = { actor: 'owner', claimId: claim.id, operation: 'edit-code', quota: f.args().quota };
  f.c.executionReady = false;
  assert.throws(() => f.c.authorizeStep(step), /adapter_not_ready/);
  f.c.executionReady = true; f.advance(3_600_000);
  assert.throws(() => f.c.authorizeStep({ ...step, quota: f.args().quota }), /invalid_execution_grant/);
});

test('one revision grant permits an exact approved edit-and-test bundle, never deployment', t => {
  const f = fixture(t);
  const p = { ...f.proposal, operations: ['run-tests', 'edit-code'] };
  f.c.registerProposal(p);
  for (const operations of [[], [, 'edit-code'], ['edit-code', 'edit-code'], ['edit-code', 'deploy']]) {
    assert.throws(() => f.c.grantExecution({ ...p, operations, kind: 'execution', decision_record_only: false, expires: f.now() + 1000 }), /invalid_operations/);
  }
  assert.throws(() => f.c.grantExecution({ ...p, operations: ['edit-code'], kind: 'execution', decision_record_only: false, expires: f.now() + 1000 }), /proposal_mismatch/);
  const id = f.c.grantExecution({ ...p, operations: ['edit-code', 'run-tests'], kind: 'execution', decision_record_only: false, expires: f.now() + 1000 });
  const claim = f.c.dispatch(f.args(id));
  for (const operation of ['edit-code', 'run-tests']) {
    assert.equal(f.c.authorizeStep({ actor: 'owner', claimId: claim.id, operation, quota: f.args().quota }).operation, operation);
  }
  for (const operation of ['open-draft-pr', 'commit', 'push', 'merge', 'deploy']) {
    assert.throws(() => f.c.authorizeStep({ actor: 'owner', claimId: claim.id, operation, quota: f.args().quota }), /operation_not_granted/);
  }
});
