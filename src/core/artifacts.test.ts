import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pullArtifact } from './artifacts.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'emu-artifacts-'));
  roots.push(root);
  const sourceDir = join(root, '.android-kit', 'runs', 'old', 'emu-lab');
  const artifactDir = join(root, '.android-kit', 'runs', 'new', 'emu-lab');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  const artifact = relative(root, join(sourceDir, 'screen.txt')).replaceAll(
    '\\',
    '/',
  );
  await writeFile(join(sourceDir, 'screen.txt'), 'screen');
  await writeFile(
    join(sourceDir, 'index.json'),
    JSON.stringify({ artifacts: [artifact] }),
  );
  return { root, sourceDir, artifactDir, artifact };
}

describe('pullArtifact', () => {
  it('copies indexed artifacts into the current run', async () => {
    const f = await fixture();
    const result = await pullArtifact({
      projectRoot: f.root,
      sourceRunId: 'old',
      artifact: f.artifact,
      artifactDir: f.artifactDir,
    });
    expect(result.source).toBe(f.artifact);
    expect(await readFile(result.path, 'utf8')).toBe('screen');
  });

  it('rejects paths outside the run and files absent from the index', async () => {
    const f = await fixture();
    await expect(
      pullArtifact({
        projectRoot: f.root,
        sourceRunId: 'old',
        artifact: '../secret',
        artifactDir: f.artifactDir,
      }),
    ).rejects.toThrow();
    await writeFile(join(f.sourceDir, 'other.txt'), 'not indexed');
    await expect(
      pullArtifact({
        projectRoot: f.root,
        sourceRunId: 'old',
        artifact: f.artifact.replace('screen.txt', 'other.txt'),
        artifactDir: f.artifactDir,
      }),
    ).rejects.toThrow();
    await expect(
      pullArtifact({
        projectRoot: f.root,
        sourceRunId: '../old',
        artifact: f.artifact,
        artifactDir: f.artifactDir,
      }),
    ).rejects.toThrow();
  });

  it('rejects an indexed symlink to a file outside the run', async () => {
    const f = await fixture();
    const outside = join(f.root, 'secret.txt');
    await writeFile(outside, 'secret');
    const link = join(f.sourceDir, 'link.txt');
    try {
      await symlink(outside, link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const artifact = f.artifact.replace('screen.txt', 'link.txt');
    await writeFile(
      join(f.sourceDir, 'index.json'),
      JSON.stringify({ artifacts: [artifact] }),
    );
    await expect(
      pullArtifact({
        projectRoot: f.root,
        sourceRunId: 'old',
        artifact,
        artifactDir: f.artifactDir,
      }),
    ).rejects.toThrow();
  });
});
