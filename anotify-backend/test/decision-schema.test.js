// 决策记录校验（DESIGN §15.3）：纯函数测试，不需要数据库
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecisionBody, validateMessageBody, DECISION_CONTENT_TYPE } from '../src/schemas.js';

const rejects = (body, re) => assert.throws(() => validateDecisionBody(body), (e) => e.status === 422 && re.test(e.message));

test('decision: normalises fields and collects prior refs', () => {
  const { payload, refs } = validateDecisionBody({
    kind: 'decision', decision: 'use codex queue',
    because: [{ type: 'fact', text: 'verified on 0.167.0' }, { type: 'prior', ref: 3, text: 'same as #3' }],
    why_notify: 'old scripts break', junk: 'dropped',
  });
  assert.deepEqual(payload, {
    v: 1, kind: 'decision', decision: 'use codex queue',
    because: [{ type: 'fact', text: 'verified on 0.167.0' }, { type: 'prior', ref: 3, text: 'same as #3' }],
    why_notify: 'old scripts break',
  });
  assert.deepEqual(refs, [3]);
});

test('decision: rejects bad reasons', () => {
  rejects({ kind: 'decision', decision: 'x', because: [] }, /1-8 reasons/);
  rejects({ kind: 'decision', decision: 'x', because: [{ type: 'hunch', text: 't' }] }, /type must be one of/);
  rejects({ kind: 'decision', decision: 'x', because: [{ type: 'prior', text: 't' }] }, /ref/);
  rejects({ kind: 'decision', decision: 'x', because: [{ type: 'fact', ref: 2, text: 't' }] }, /only allowed for type "prior"/);
  rejects({ kind: 'decision', decision: ' ', because: [{ type: 'fact', text: 't' }] }, /decision must be/);
  rejects({ kind: 'decision', decision: 'x', because: Array(9).fill({ type: 'fact', text: 't' }) }, /1-8 reasons/);
});

const opts = [{ id: 'A', label: 'now', outcome: 'auto-start', recommended: true }, { id: 'B', label: 'later', outcome: 'manual' }];

test('handoff: valid record keeps done_so_far as refs', () => {
  const { payload, refs } = validateDecisionBody({ kind: 'handoff', question: 'install?', why_you: 'changes system tasks', done_so_far: [2, 5], options: opts, blocked: 'idle wake' });
  assert.equal(payload.options[0].recommended, true);
  assert.deepEqual(payload.done_so_far, [2, 5]);
  assert.deepEqual(refs, [2, 5]);
  assert.equal(payload.default_action, undefined);
});

test('handoff: rejects bad options', () => {
  rejects({ kind: 'handoff', question: 'q', why_you: 'y', options: [opts[0]] }, /2-6 options/);
  rejects({ kind: 'handoff', question: 'q', why_you: 'y', options: [{ ...opts[1] }, { ...opts[0] }] }, /must be "A"/);
  rejects({ kind: 'handoff', question: 'q', why_you: 'y', options: [{ ...opts[0] }, { id: 'B', label: 'l', outcome: 'o', recommended: true }] }, /at most one/);
  rejects({ kind: 'handoff', question: 'q', why_you: '', options: opts }, /why_you/);
  rejects({ kind: 'handoff', question: 'q', why_you: 'y', options: [{ id: 'A', label: 'l' }, opts[1]] }, /outcome/);
});

test('resolution: needs reply_to and note; chosen must be A-F', () => {
  const ok = validateDecisionBody({ kind: 'resolution', reply_to: 7, chosen: 'B', note: 'user agreed' });
  assert.deepEqual(ok.payload, { v: 1, kind: 'resolution', chosen: 'B', note: 'user agreed', decided_by: 'human' });
  assert.equal(ok.reply_to, 7);
  rejects({ kind: 'resolution', note: 'n' }, /requires reply_to/);
  rejects({ kind: 'resolution', reply_to: 7 }, /note/);
  rejects({ kind: 'resolution', reply_to: 7, note: 'n', chosen: 'Z' }, /chosen/);
  rejects({ kind: 'resolution', reply_to: 7, note: 'n', decided_by: 'user' }, /decided_by/);
});

test('unknown kind / non-object bodies are rejected; decision content type cannot be posted as a plain message', () => {
  rejects({ kind: 'nope' }, /kind must be/);
  rejects(null, /JSON object/);
  rejects([], /JSON object/);
  assert.throws(() => validateMessageBody({ content: '{}', content_type: DECISION_CONTENT_TYPE }), (e) => e.status === 422);
});
