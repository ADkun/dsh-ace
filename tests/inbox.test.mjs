import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { INBOX_CAP, readInbox, writeInboxAtomic, addToInbox, inboxFull } from '../lib/inbox.js';

test('INBOX_CAP is 20', () => {
  assert.equal(INBOX_CAP, 20);
});

test('readInbox: nonexistent file => []', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ace-inbox-'));
  const file = path.join(dir, 'merge-inbox');
  const items = await readInbox(file);
  assert.deepEqual(items, []);
});

test('writeInboxAtomic + readInbox roundtrip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ace-inbox-'));
  const file = path.join(dir, 'merge-inbox');
  const items = [{ newEntryId: 'ace-001', bestMatchId: 'ace-002' }];
  await writeInboxAtomic(file, items);
  const read = await readInbox(file);
  assert.deepEqual(read, items);
});

test('writeInboxAtomic: creates parent dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ace-inbox-'));
  const file = path.join(dir, 'sub', 'merge-inbox');
  await writeInboxAtomic(file, [{ a: 1 }]);
  const read = await readInbox(file);
  assert.deepEqual(read, [{ a: 1 }]);
});

test('addToInbox: adds item', () => {
  const result = addToInbox([], { id: 1 });
  assert.equal(result.capped, false);
  assert.equal(result.items.length, 1);
});

test('addToInbox: caps at cap', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  const result = addToInbox(items, { id: 99 });
  assert.equal(result.capped, true);
  assert.equal(result.items.length, 20);
  assert.equal(result.items[19].id, 19); // last item unchanged
});

test('addToInbox: respects custom cap', () => {
  const items = [{ id: 1 }, { id: 2 }];
  const result = addToInbox(items, { id: 3 }, 2);
  assert.equal(result.capped, true);
  assert.equal(result.items.length, 2);
});

test('inboxFull: at cap => true', () => {
  const items = Array.from({ length: INBOX_CAP }, (_, i) => ({ id: i }));
  assert.equal(inboxFull(items), true);
});

test('inboxFull: below cap => false', () => {
  assert.equal(inboxFull([{ id: 1 }]), false);
  assert.equal(inboxFull([]), false);
});

test('inboxFull: over cap => true', () => {
  const items = Array.from({ length: INBOX_CAP + 5 }, (_, i) => ({ id: i }));
  assert.equal(inboxFull(items), true);
});
