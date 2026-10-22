import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeCatalogFiles } from '../server/catalog-files.js';

test('a leftover catalog directory without its index is replaced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-files-test-'));
  try {
    const dir = path.join(root, 'catalog');
    fs.mkdirSync(path.join(dir, 'tables'), { recursive: true });
    writeCatalogFiles(dir);
    assert.ok(fs.existsSync(path.join(dir, 'table-index.json')));
    assert.ok(fs.readdirSync(path.join(dir, 'tables')).length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
