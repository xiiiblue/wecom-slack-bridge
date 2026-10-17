import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { formatDeadline } from '../src/text.js';

test('deadline converts UTC to readable UTC+08 without milliseconds or suffix', () => {
  assert.equal(formatDeadline(Date.parse('2026-10-18T00:42:52.882Z')), '2026-10-18 08:42:52');
});
test('deadline rolls over to the next day in UTC+08', () => {
  assert.equal(formatDeadline(Date.parse('2026-10-18T16:00:00.999Z')), '2026-10-19 00:00:00');
});
test('deadline rolls over month and year in UTC+08', () => {
  assert.equal(formatDeadline(Date.parse('2026-12-31T16:42:52.882Z')), '2027-01-01 00:42:52');
  assert.equal(formatDeadline(Date.parse('2028-02-29T16:00:00.000Z')), '2028-03-01 00:00:00');
});
for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
  test(`deadline output is independent of server TZ=${tz}`, () => {
    const moduleUrl = new URL('../src/text.js', import.meta.url).href;
    const code = `import {formatDeadline} from ${JSON.stringify(moduleUrl)}; console.log(formatDeadline(1792284172882));`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(result.trim(), '2026-10-18 08:42:52');
  });
}
