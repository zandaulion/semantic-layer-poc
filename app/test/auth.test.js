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
