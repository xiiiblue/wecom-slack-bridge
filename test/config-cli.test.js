import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { WECOM_BOT_ID: 'synthetic-bot', WECOM_BOT_SECRET: 'synthetic-secret', WECOM_OWNER_USER_ID: 'owner', WECOM_ALLOWED_CHAT_IDS: 'synthetic-group', SLACK_BOT_TOKEN: 'synthetic-token', SLACK_APP_TOKEN: 'synthetic-app', SLACK_CHANNEL_ID: 'C123', SLACK_REPLY_BOT_ID: 'B123' };
test('offline config command validates without creating state or exposing values', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'not-created');
  const run = spawnSync(process.execPath, ['scripts/check-config.js'], { env: { ...env, STATE_DIR: state }, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).event, 'config_valid'); assert.equal(run.stderr, '');
  assert.equal(existsSync(state), false);
  for (const value of Object.values(env)) assert.ok(!run.stdout.includes(value));
});
test('offline config command fails closed with redacted invalid-field output', () => {
  const run = spawnSync(process.execPath, ['scripts/check-config.js'], { env: { ...env, SLACK_REPLY_USER_ID: 'U123' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 78); assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).event, 'config_invalid');
  for (const secret of ['synthetic-secret', 'synthetic-token', 'synthetic-app']) assert.ok(!run.stderr.includes(secret));
});
