import { constants } from 'node:fs';
import { copyFile, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { runArtifactDir } from '@budaknyenyel/kit-schema';

function inside(directory: string, path: string): boolean {
  const part = relative(directory, path);
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith(`..${sep}`) &&
    !isAbsolute(part)
  );
}

export interface PullArtifactOptions {
  projectRoot: string;
  sourceRunId: string;
  artifact: string;
  artifactDir: string;
}

/** Copy an indexed artifact from a previous run into this operation's artifact directory. */
export async function pullArtifact(
  options: PullArtifactOptions,
): Promise<{ path: string; source: string }> {
  const root = resolve(options.projectRoot);
  const sourceDir = resolve(
    runArtifactDir(root, options.sourceRunId, 'emu-lab'),
  );
  const source = resolve(root, options.artifact);
  const destinationDir = resolve(options.artifactDir);
  const runsDir = resolve(root, '.android-kit', 'runs');
  if (
    isAbsolute(options.artifact) ||
    !inside(sourceDir, source) ||
    !inside(runsDir, destinationDir)
  ) {
    throw new Error('Artifact paths must remain inside their run directories');
  }

  const realRoot = await realpath(root);
  const realRuns = await realpath(runsDir);
  const realSourceDir = await realpath(sourceDir);
  const realDestinationDir = await realpath(destinationDir);
  if (
    !inside(realRoot, realRuns) ||
    !inside(realRuns, realSourceDir) ||
    !inside(realRuns, realDestinationDir)
  ) {
    throw new Error('Run directory resolves outside the project');
  }
  const indexPath = resolve(sourceDir, 'index.json');
  const realIndex = await realpath(indexPath);
  if (!inside(realSourceDir, realIndex))
    throw new Error('Artifact index resolves outside the run directory');
  const index: unknown = JSON.parse(await readFile(realIndex, 'utf8'));
  const entries =
    index && typeof index === 'object' && 'artifacts' in index
      ? index.artifacts
      : undefined;
  const normalized = relative(root, source).split(sep).join('/');
  if (!Array.isArray(entries) || !entries.includes(normalized))
    throw new Error('Artifact is not listed in the run index');
  const realSource = await realpath(source);
  if (!inside(realSourceDir, realSource) || !(await stat(realSource)).isFile())
    throw new Error(
      'Artifact resolves outside the run directory or is not a file',
    );
  const destination = resolve(realDestinationDir, basename(source));
  await copyFile(realSource, destination, constants.COPYFILE_EXCL);
  return { path: destination, source: normalized };
}
