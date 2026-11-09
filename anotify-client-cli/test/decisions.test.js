// 决策轨迹 CLI 辅助函数（DESIGN §15.5）：纯函数，不需要服务端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBecause, buildOptions, parseDone, decisionRecord, decisionLines, humanHandoffText, DECISION_CONTENT_TYPE,
} from '../src/decisions.js';
import { contentLines } from '../src/render.js';

test('parseBecause: types, prior refs, errors', () => {
  assert.deepEqual(parseBecause('fact:codex 0.167.0 verified'), { type: 'fact', text: 'codex 0.167.0 verified' });
  assert.deepEqual(parseBecause('prior:#12 same single-listener rule'), { type: 'prior', ref: 12, text: 'same single-listener rule' });
  assert.deepEqual(parseBecause('prior:12:colon form'), { type: 'prior', ref: 12, text: 'colon form' });
  assert.throws(() => parseBecause('hunch:maybe'), /--because must look like/);
  assert.throws(() => parseBecause('prior:no seq here'), /needs a seq/);
  assert.throws(() => parseBecause('fact:'), /no text/);
});

test('buildOptions: ids A.. in order, recommend flag, validation', () => {
  const o = buildOptions(['install now=>auto-start after reboot', 'run temporarily=>manual restart'], 'a');
  assert.deepEqual(o, [
    { id: 'A', label: 'install now', outcome: 'auto-start after reboot', recommended: true },
    { id: 'B', label: 'run temporarily', outcome: 'manual restart' },
  ]);
  assert.throws(() => buildOptions(['only one=>x']), /2-6/);
  assert.throws(() => buildOptions(['a=>x', 'b=>y'], 'C'), /--recommend/);
  assert.throws(() => buildOptions(['no arrow', 'b=>y']), /--option must be/);
});

test('parseDone: seq with optional summary', () => {
  assert.deepEqual(parseDone('12'), { seq: 12, summary: undefined });
  assert.deepEqual(parseDone('#15:chose codex queue'), { seq: 15, summary: 'chose codex queue' });
  assert.throws(() => parseDone('abc'), /--done must be/);
});

const msg = (rec, extra = {}) => ({ content_type: DECISION_CONTENT_TYPE, content: JSON.stringify(rec), seq: 9, ...extra });

test('recv rendering: contentLines shows summaries, never raw JSON; bad JSON falls back to text', () => {
  const dec = msg({ v: 1, kind: 'decision', decision: 'use queue', because: [{ type: 'prior', ref: 3, text: 'as #3' }], why_notify: 'scripts break' });
  assert.deepEqual(contentLines(dec, 'dev'), ['◆ decision: use queue', '  because [prior #3] as #3', '  why notify: scripts break']);
  const res = msg({ v: 1, kind: 'resolution', chosen: 'A', note: 'user ok', decided_by: 'human' }, { reply_to: 7 });
  assert.deepEqual(contentLines(res, 'dev'), ['✓ resolution of #7: chose A — user ok (decided by human)']);
  const bad = { content_type: DECISION_CONTENT_TYPE, content: 'not json', seq: 1 };
  assert.equal(decisionRecord(bad), null);
  assert.deepEqual(contentLines(bad, 'dev'), ['not json']);
});

test('humanHandoffText: has everything the human needs to decide', () => {
  const rec = {
    v: 1, kind: 'handoff', question: 'Install as a startup task?', why_you: 'changes system scheduled tasks',
    done_so_far: [12],
    options: [{ id: 'A', label: 'install', outcome: 'survives reboot', recommended: true }, { id: 'B', label: 'temporary', outcome: 'dies on reboot' }],
    blocked: 'no wake across reboots', default_action: 'stay temporary after 24h',
  };
  const t = humanHandoffText({ channel: 'ops', seq: 20, rec, done: [{ seq: 12, summary: 'use codex queue' }] });
  for (const needle of ['#20', '"ops"', 'Already decided', '#12 use codex queue', 'Question:', 'Why this is your call', '**A** install — *my recommendation*: survives reboot', '**B** temporary: dies on reboot', "If you don't decide", 'Default if no answer']) {
    assert.ok(t.includes(needle), `missing: ${needle}\n${t}`);
  }
  assert.deepEqual(decisionLines(rec, { seq: 20 })[0], '◇ handoff: Install as a startup task?');
});
