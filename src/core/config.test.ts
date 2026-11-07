import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from './config.js';

vi.mock('./build.js', () => ({ build: vi.fn().mockResolvedValue({}) }));

import { build } from './build.js';
import { dispatch } from './index.js';

describe('build configuration', () => {
  it('loads defaults, applies explicit arguments, and rejects invalid configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emu-lab-config-'));
    try {
      await writeFile(
        join(root, 'android-kit.yaml'),
        'emuLab:\n  build:\n    variant: demoDebug\n    testVariant: demoTestDebug\n',
      );
      expect((await readConfig(root)).build).toEqual({
        variant: 'demoDebug',
        testVariant: 'demoTestDebug',
      });
      await dispatch('build', { projectRoot: root });
      expect(build).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: 'demoDebug',
          testVariant: 'demoTestDebug',
        }),
      );
      await dispatch('build', {
        projectRoot: root,
        variant: 'otherDebug',
        testVariant: 'otherTestDebug',
      });
      expect(build).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: 'otherDebug',
          testVariant: 'otherTestDebug',
        }),
      );
      await writeFile(
        join(root, 'android-kit.yaml'),
        'emuLab:\n  build:\n    variant: bad-variant\n',
      );
      await expect(readConfig(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
