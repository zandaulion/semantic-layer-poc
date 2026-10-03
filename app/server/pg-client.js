/**
 * Just enough of the PostgreSQL wire protocol to run one read-only query and
 * read its rows as text: startup, password authentication (SCRAM-SHA-256, MD5
 * or cleartext), and the simple query protocol.
 *
 * Written rather than installed because the application has no runtime
 * dependencies, and the benchmark runs this same code in a bare node image.
 * One connection per query: the warehouse is asked a handful of questions a
 * minute, and nothing pooled can outlive a statement it should not have.
 */

import crypto from 'node:crypto';
import net from 'node:net';

function message(type, body) {
  const header = Buffer.alloc(type ? 5 : 4);
  if (type) header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, type ? 1 : 0);
  return Buffer.concat([header, body]);
}

const cstring = (text) => Buffer.from(`${text}\0`, 'utf8');

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return [buffer.toString('utf8', offset, end), end + 1];
}

function parseError(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const [value, next] = readCString(body, offset + 1);
    fields[code] = value;
    offset = next;
  }
  return fields;
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();

export function parseConnectionUrl(text) {
  const url = new URL(text);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || decodeURIComponent(url.username),
  };
}

/**
 * Runs `sql` and resolves `{ columns, rows }`, every value a string or null.
 * Rejects with the server's message for a failed statement, and with a
 * timeout if nothing is finished within `timeoutMs`.
 */
export function pgQuery(connection, sql, { timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const { host, port, user, password, database } = typeof connection === 'string' ? parseConnectionUrl(connection) : connection;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let received = 0;
    let columns = [];
    const rows = [];
    let failure = null;
    let scram = null;
    let settled = false;
    let sent = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket.destroyed) {
        try { socket.end(message('X', Buffer.alloc(0))); } catch { /* closing anyway */ }
        socket.destroy();
      }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`The warehouse did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);

    socket.on('error', (error) => finish(new Error(`Cannot reach the warehouse: ${error.code || error.message}`)));
    socket.on('close', () => finish(new Error('The warehouse closed the connection')));
    socket.on('connect', () => {
      const parameters = Buffer.concat([cstring('user'), cstring(user), cstring('database'), cstring(database), cstring('application_name'), cstring('bank-dwh-studio'), Buffer.from([0])]);
      const version = Buffer.alloc(4);
      version.writeInt32BE(196608);
      socket.write(message('', Buffer.concat([version, parameters])));
    });

    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) return finish(new Error('The result is too large to return'));
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) break;
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        try { handle(type, body); }
        catch (error) { return finish(error); }
        if (settled) return;
      }
    });

    function handle(type, body) {
      if (type === 'R') {
        const code = body.readInt32BE(0);
        if (code === 0) return;
        if (code === 3) return socket.write(message('p', cstring(password)));
        if (code === 5) {
          const inner = crypto.createHash('md5').update(password + user).digest('hex');
          const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), body.subarray(4, 8)])).digest('hex');
          return socket.write(message('p', cstring(`md5${outer}`)));
        }
        if (code === 10) {
          const nonce = crypto.randomBytes(18).toString('base64');
          const bare = `n=,r=${nonce}`;
          scram = { nonce, bare };
          const first = Buffer.from(`n,,${bare}`);
          const size = Buffer.alloc(4);
          size.writeInt32BE(first.length);
          return socket.write(message('p', Buffer.concat([cstring('SCRAM-SHA-256'), size, first])));
        }
        if (code === 11) {
          const serverFirst = body.subarray(4).toString('utf8');
          const parts = Object.fromEntries(serverFirst.split(',').map((part) => [part[0], part.slice(2)]));
          if (!parts.r?.startsWith(scram.nonce)) throw new Error('The warehouse sent an invalid SCRAM nonce');
          const salted = crypto.pbkdf2Sync(password, Buffer.from(parts.s, 'base64'), Number(parts.i), 32, 'sha256');
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const withoutProof = `c=biws,r=${parts.r}`;
          const authMessage = `${scram.bare},${serverFirst},${withoutProof}`;
          const signature = hmac(storedKey, authMessage);
          const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]));
          scram.expected = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
          return socket.write(message('p', Buffer.from(`${withoutProof},p=${proof.toString('base64')}`)));
        }
        if (code === 12) {
          const verifier = body.subarray(4).toString('utf8').match(/v=([^,]+)/)?.[1];
          if (verifier !== scram?.expected) throw new Error('The warehouse could not prove it knows the password');
          return;
        }
        throw new Error(`Unsupported authentication method ${code}`);
      }
      if (type === 'Z') {
        // Ready: the first time after startup, send the query; the second
        // time, it has been answered.
        if (!sent) {
          sent = true;
          return socket.write(message('Q', cstring(sql)));
        }
        if (failure) return finish(Object.assign(new Error(failure.M || 'Query failed'), { sqlState: failure.C, position: failure.P }));
        return finish(null, { columns, rows });
      }
      if (type === 'E') {
        const fields = parseError(body);
        // Before the query is sent, an error ends the session: no ready
        // message follows.
        if (!sent) throw new Error(fields.M || 'The warehouse refused the connection');
        failure = failure ?? fields;
        return;
      }
      if (type === 'T') {
        const count = body.readInt16BE(0);
        let offset = 2;
        columns = [];
        for (let index = 0; index < count; index++) {
          const [name, next] = readCString(body, offset);
          columns.push(name);
          offset = next + 18;
        }
        return;
      }
      if (type === 'D') {
        const count = body.readInt16BE(0);
        let offset = 2;
        const row = [];
        for (let index = 0; index < count; index++) {
          const size = body.readInt32BE(offset);
          offset += 4;
          if (size < 0) row.push(null);
          else { row.push(body.toString('utf8', offset, offset + size)); offset += size; }
        }
        rows.push(row);
      }
      // S (parameter status), K (backend key), C (command complete),
      // N (notice), I (empty query): nothing to keep.
    }
  });
}
