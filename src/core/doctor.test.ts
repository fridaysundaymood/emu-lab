import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import { maestroExecutable } from './doctor.js';

it('prefers explicit and environment paths, then PATH, then the standard install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-discovery-'));
  const oldPath = process.env.PATH;
  const oldBin = process.env.MAESTRO_BIN;
  const name = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', name), '');
    process.env.PATH = [join(root, 'bin')].join(delimiter);
    process.env.MAESTRO_BIN = 'environment-maestro';
    expect(await maestroExecutable({ maestroPath: 'configured-maestro' })).toBe(
      'configured-maestro',
    );
    expect(await maestroExecutable({})).toBe('environment-maestro');
    delete process.env.MAESTRO_BIN;
    expect(await maestroExecutable({})).toBe(join(root, 'bin', name));
    process.env.PATH = root;
    expect(await maestroExecutable({})).toContain(
      join('.maestro', 'maestro', 'bin', name),
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldBin === undefined) delete process.env.MAESTRO_BIN;
    else process.env.MAESTRO_BIN = oldBin;
    await rm(root, { recursive: true, force: true });
  }
});

it('accepts the documented Maestro version range and rejects versions outside it', async () => {
  const { maestroVersionSupported } = await import('./doctor.js');
  for (const version of ['2.11.0', '2.12.0', '2.12.1']) {
    expect(maestroVersionSupported(`maestro ${version}`)).toBe(true);
  }
  for (const version of ['2.10.9', '2.13.0', '3.0.0']) {
    expect(maestroVersionSupported(`maestro ${version}`)).toBe(false);
  }
});

it('runs a batch-file version probe from a path containing spaces', async () => {
  if (process.platform !== 'win32') return;
  const { doctor } = await import('./doctor.js');
  const root = await mkdtemp(join(tmpdir(), 'maestro with space-'));
  const oldPath = process.env.MAESTRO_BIN;
  try {
    const bin = join(root, 'maestro.bat');
    await writeFile(bin, '@echo off\r\necho 2.11.0\r\n');
    process.env.MAESTRO_BIN = bin;
    const result = await doctor({});
    expect(result.checks.find((c) => c.tool === 'maestro')).toMatchObject({
      available: true,
      version: '2.11.0',
    });
  } finally {
    if (oldPath === undefined) delete process.env.MAESTRO_BIN;
    else process.env.MAESTRO_BIN = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
