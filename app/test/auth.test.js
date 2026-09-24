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
