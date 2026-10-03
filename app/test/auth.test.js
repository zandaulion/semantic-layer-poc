import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthStore, constantTimeTokenMatch, cookieForToken, tokenFromCookie } from '../server/auth.js';

test('an invite registers exactly one revocable device', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banking-auth-'));
  const auth = new AuthStore(path.join(dir, 'auth.sqlite'));
  t.after(() => { auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const invite = auth.createInvite('Tester', 'https://example.test');
  assert.match(invite.url, /\?invite=/);
  assert.equal(auth.listInvites().invites[0].code, invite.code);
  const result = auth.redeemInvite(invite.code, 'Laptop');
  assert.equal(result.label, 'Laptop');
  assert.equal(auth.redeemInvite(invite.code).error, 'invalid_invite');
  assert.equal(auth.listInvites().invites[0].code, null);
  assert.equal(auth.deviceForToken(result.token).id, result.device_id);
  assert.equal(auth.setDeviceRevoked(result.device_id, true), true);
  assert.equal(auth.deviceForToken(result.token), null);
});

test('cookie carries the opaque token and admin comparison requires configured secret', () => {
  const cookie = cookieForToken('secret-token', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(tokenFromCookie(cookie), 'secret-token');
  assert.equal(constantTimeTokenMatch('a', ''), false);
  assert.equal(constantTimeTokenMatch('a', 'a'), true);
  assert.equal(constantTimeTokenMatch('b', 'a'), false);
});

test('query history persists, paginates, and stays private to a device', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banking-history-'));
  let auth = new AuthStore(path.join(dir, 'auth.sqlite'));
  t.after(() => { auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = auth.redeemInvite(auth.createInvite('Owner').code, 'Owner');
  const other = auth.redeemInvite(auth.createInvite('Other').code, 'Other');
  const response = { status: 'draft', sql: 'SELECT 1', interpretation: 'Test draft', assumptions: [] };
  const ids = [1, 2, 3].map((number) => auth.saveHistory(owner.device_id, `Question ${number}`, 'all', response));
  const first = auth.listHistory(owner.device_id, 2);
  assert.deepEqual(first.entries.map((entry) => entry.id), [ids[2], ids[1]]);
  assert.equal(first.next_before, ids[1]);
  assert.deepEqual(auth.listHistory(owner.device_id, 2, first.next_before).entries.map((entry) => entry.id), [ids[0]]);
  assert.deepEqual(auth.listHistory(other.device_id).entries, []);
  assert.equal(auth.getHistory(other.device_id, ids[0]), null);
  assert.equal(auth.deleteHistory(other.device_id, ids[0]), false);
  auth.close();
  auth = new AuthStore(path.join(dir, 'auth.sqlite'));
  assert.equal(auth.getHistory(owner.device_id, ids[0]).result.sql, 'SELECT 1');
  assert.equal(auth.deleteHistory(owner.device_id, ids[1]), true);
  assert.equal(auth.getHistory(owner.device_id, ids[1]), null);
  assert.equal(auth.deleteDevice(owner.device_id), true);
  assert.deepEqual(auth.listHistory(owner.device_id).entries, []);
});

test('a conversation replays its earlier turns, oldest first, to its own device only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-conv-'));
  const store = new AuthStore(path.join(dir, 'auth.sqlite'));
  try {
    const invite = store.createInvite('a');
    const device = store.redeemInvite(invite.code, 'a');
    const other = store.redeemInvite(store.createInvite('b').code, 'b');
    const conversation = '11111111-2222-3333-4444-555555555555';
    store.saveHistory(device.device_id, 'Clients in default at end of August', 'all', { status: 'needs_clarification', clarification_question: 'Which year?' }, conversation);
    store.saveHistory(device.device_id, 'Answer to your question: 2025', 'all', { status: 'draft', interpretation: 'Counts clients.', sql: 'SELECT 1' }, conversation);
    const turns = store.conversationTurns(device.device_id, conversation);
    assert.deepEqual(turns.map((turn) => turn.question), ['Clients in default at end of August', 'Answer to your question: 2025']);
    assert.match(turns[0].summary, /Which year/);
    assert.match(turns[1].summary, /SELECT 1/);
    assert.deepEqual(store.conversationTurns(other.device_id, conversation), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit log outlives the device it records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-audit-'));
  const store = new AuthStore(path.join(dir, 'auth.sqlite'));
  try {
    const device = store.redeemInvite(store.createInvite('a').code, 'phone');
    store.audit({ id: device.device_id, label: 'phone' }, 'execute', { sql: 'SELECT 1', ok: true });
    store.deleteDevice(device.device_id);
    const { entries } = store.listAudit();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].device_label, 'phone');
    assert.equal(entries[0].detail.sql, 'SELECT 1');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
