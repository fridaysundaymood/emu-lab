import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { collectDiagnostics } from './diagnostics.js';

it('redacts split console tokens and labelled tokens before persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'emu-diagnostics-'));
  try {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const snapshot = collectDiagnostics([stdout, stderr], 'synthetic-secret');
    stdout.write('console synthetic-');
    stdout.write('secret\n');
    stderr.write('authentication token: another-secret\n');
    const path = join(dir, 'emulator.log');
    await writeFile(path, snapshot());
    const data = await readFile(path, 'utf8');
    expect(data).not.toContain('synthetic-secret');
    expect(data).not.toContain('another-secret');
    expect(data).toContain('[redacted]');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('withholds output if the console token is unavailable', () => {
  const stream = new PassThrough();
  const snapshot = collectDiagnostics([stream], '');
  stream.write('unknown secret\n');
  expect(snapshot()).not.toContain('unknown secret');
});
