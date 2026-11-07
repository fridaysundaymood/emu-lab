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
