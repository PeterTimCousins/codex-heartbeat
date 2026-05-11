import assert from 'node:assert/strict';
import test from 'node:test';
import { slugifyName } from '../src/fs-util.mjs';

test('slugifyName accepts stable session names', () => {
  assert.equal(slugifyName('dropship-main_1.2'), 'dropship-main_1.2');
});

test('slugifyName rejects names that would escape the session directory', () => {
  assert.throws(() => slugifyName('../bad'));
  assert.throws(() => slugifyName('bad/name'));
  assert.throws(() => slugifyName(''));
});
