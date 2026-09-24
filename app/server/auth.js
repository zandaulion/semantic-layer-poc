import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const COOKIE_NAME = 'semantic_device';
export const INVITE_TTL_DAYS = 7;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const now = () => new Date().toISOString();

function randomCode(length = 10) {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function constantTimeTokenMatch(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function cookieForToken(token, secure = true) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=31536000',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearCookie(secure = true) {
  return [
    `${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=0', ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function tokenFromCookie(header = '') {
  const match = String(header).match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export class AuthStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        code TEXT,
        url TEXT,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.failures = [];
  }

  close() { this.db.close(); }

  createInvite(label = '', publicBaseUrl = '') {
    const code = randomCode();
    const url = publicBaseUrl ? `${publicBaseUrl}/?invite=${encodeURIComponent(code)}` : null;
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
    const result = this.db.prepare(`
      INSERT INTO invites (code_hash, code, url, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hash(normalise(code)), code, url, String(label).slice(0, 60), now(), expiresAt);
    return { id: Number(result.lastInsertRowid), code, url, label: String(label).slice(0, 60), expires_at: expiresAt, expires_in_days: INVITE_TTL_DAYS };
  }

  listInvites() {
    const invites = this.db.prepare(`
      SELECT id, label, code, url, created_at, expires_at, used_at, device_id, revoked
      FROM invites ORDER BY id DESC
    `).all().map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
    return { ttl_days: INVITE_TTL_DAYS, invites };
  }

  revokeInvite(id) {
    return this.db.prepare(`
      UPDATE invites SET revoked=1, code=NULL, url=NULL
      WHERE id=? AND used_at IS NULL AND revoked=0
    `).run(id).changes === 1;
  }

  redeemInvite(code, label = '') {
    const normalised = normalise(code);
    const cutoff = Date.now() - 10 * 60_000;
    this.failures = this.failures.filter((time) => time > cutoff);
    if (this.failures.length >= 20) return { error: 'throttled' };
    if (normalised.length !== 10) return { error: 'invalid_invite' };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare(`
        SELECT id FROM invites WHERE code_hash=? AND used_at IS NULL
          AND revoked=0 AND expires_at>?
      `).get(hash(normalised), now());
      if (!invite) {
        this.db.exec('ROLLBACK');
        this.failures.push(Date.now());
        return { error: 'invalid_invite' };
      }
      const deviceId = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('base64url');
      const deviceLabel = String(label || 'My device').trim().slice(0, 60) || 'My device';
      this.db.prepare(`
        INSERT INTO devices (id, token_hash, label, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?)
      `).run(deviceId, hash(token), deviceLabel, now(), now());
      const claimed = this.db.prepare(`
        UPDATE invites SET used_at=?, device_id=?, code=NULL, url=NULL
        WHERE id=? AND used_at IS NULL AND revoked=0 AND expires_at>?
      `).run(now(), deviceId, invite.id, now());
      if (claimed.changes !== 1) throw new Error('Invite was already redeemed');
      this.db.exec('COMMIT');
      return { token, device_id: deviceId, label: deviceLabel };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deviceForToken(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked=0').get(hash(token));
    if (!row) return null;
    this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), row.id);
    return { id: row.id, label: row.label, created_at: row.created_at, last_seen: row.last_seen };
  }

  listDevices() {
    return { devices: this.db.prepare(`
      SELECT id, label, created_at, last_seen, revoked FROM devices ORDER BY created_at DESC
    `).all().map((row) => ({ ...row, revoked: Boolean(row.revoked), has_push: false })) };
  }

  setDeviceRevoked(id, revoked) {
    return this.db.prepare('UPDATE devices SET revoked=? WHERE id=?').run(revoked ? 1 : 0, id).changes === 1;
  }

  setDeviceLabel(id, label) {
    return this.db.prepare('UPDATE devices SET label=? WHERE id=?').run(String(label).slice(0, 60), id).changes === 1;
  }

  deleteDevice(id) {
    return this.db.prepare('DELETE FROM devices WHERE id=?').run(id).changes === 1;
  }
}
