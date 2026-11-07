import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runArtifactDir, writeArtifactIndex } from '@android-kit/schema';

const execFile = promisify(execFileCallback);
export interface BuildOptions {
  projectRoot: string;
  runId: string;
  variant: string;
  testVariant?: string;
  commit?: string;
  module?: string;
  release?: boolean;
  sdkRoot?: string;
}
export interface BuildResult {
  artifacts: string[];
  versionCode: number | null;
  signingDigest: string | null;
  cacheKey: string;
  cached: boolean;
}
interface CacheRecord {
  files: string[];
  versionCode: number | null;
  signingDigest: string | null;
}
const ignored: Record<string, true> = {
  '.git': true,
  '.gradle': true,
  '.kotlin': true,
  '.android-kit': true,
  build: true,
  node_modules: true,
};

async function files(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (ignored[entry.name] || entry.isSymbolicLink()) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else if (entry.isFile()) result.push(relative(root, path));
  }
  return result;
}
async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await files(root)) {
    hash.update(path.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(join(path, 'owner'), String(process.pid));
      return async () => {
        await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(join(path, 'owner'), 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
              await rm(path, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const age = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!age) continue;
        if (Date.now() - age.mtimeMs > 60_000) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      }
      const { promise, resolve: wake } = Promise.withResolvers<void>();
      setTimeout(wake, 200);
      await promise;
    }
  }
}
async function findOutputs(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(apk|aab)$/i.test(entry.name))
        result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const root = resolve(options.projectRoot);
  if (
    !/^[A-Za-z][A-Za-z0-9]*$/.test(options.variant) ||
    (options.testVariant !== undefined &&
      !/^[A-Za-z][A-Za-z0-9]*$/.test(options.testVariant)) ||
    (options.module && !/^[A-Za-z0-9_.-]+$/.test(options.module))
  )
    throw new Error('Invalid Gradle variant or module');
  const module = options.module ?? 'app';
  const release = options.release ?? /release$/i.test(options.variant);
  const tree = options.commit
    ? (
        await execFile(
          'git',
          ['rev-parse', '--verify', `${options.commit}^{tree}`],
          { cwd: root },
        )
      ).stdout.trim()
    : await treeHash(root);
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        tree,
        module,
        options.variant,
        options.testVariant ?? options.variant,
        release,
      ]),
    )
    .digest('hex');
  const cacheRoot = join(root, '.android-kit', 'emu-lab', 'builds');
  const cache = join(cacheRoot, key);
  const unlock = await lock(join(cacheRoot, 'locks', key));
  let releaseUnlock: (() => Promise<void>) | undefined;
  let temp: string | undefined;
  try {
    let record: CacheRecord | undefined;
    try {
      record = JSON.parse(
        await readFile(join(cache, 'result.json'), 'utf8'),
      ) as CacheRecord;
      for (const file of record.files) await access(join(cache, file));
    } catch {
      record = undefined;
    }
    const cached = record !== undefined;
    if (!record) {
      if (release)
        releaseUnlock = await lock(
          join(tmpdir(), 'android-kit-emu-lab-release.lock'),
        );
      temp = await mkdtemp(join(tmpdir(), 'emu-lab-build-'));
      const source = join(temp, 'source');
      if (options.commit) {
        await execFile('git', [
          'clone',
          '--no-hardlinks',
          '--no-checkout',
          root,
          source,
        ]);
        await execFile('git', ['checkout', '--detach', options.commit], {
          cwd: source,
        });
      } else {
        await cp(root, source, {
          recursive: true,
          filter: (path) => path === root || !ignored[basename(path)],
        });
        if ((await treeHash(source)) !== tree)
          throw new Error('Worktree changed while preparing build');
      }
      const init = join(temp, 'isolate.gradle');
      const outputRoot = join(temp, 'outputs')
        .replaceAll('\\', '/')
        .replaceAll("'", "\\'");
      await writeFile(
        init,
        `gradle.beforeProject { p -> p.layout.buildDirectory.set(new File('${outputRoot}', p.path.replace(':', '/'))) }\n`,
      );
      const wrapper = join(
        source,
        process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
      );
      const variant =
        options.variant[0]!.toUpperCase() + options.variant.slice(1);
      const testVariant = options.testVariant ?? options.variant;
      const testTaskVariant =
        testVariant[0]!.toUpperCase() + testVariant.slice(1);
      const args = [
        `:${module}:assemble${variant}`,
        ...(release
          ? [`:${module}:bundle${variant}`]
          : [`:${module}:assemble${testTaskVariant}AndroidTest`]),
        '--project-cache-dir',
        join(temp, 'project-cache'),
        '--init-script',
        init,
        '--no-daemon',
      ];
      if (process.platform === 'win32')
        await execFile(
          process.env.ComSpec ?? 'cmd.exe',
          [
            '/d',
            '/s',
            '/c',
            `""${wrapper}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
          ],
          {
            cwd: source,
            maxBuffer: 64 * 1024 * 1024,
            windowsVerbatimArguments: true,
          },
        );
      else
        await execFile(wrapper, args, {
          cwd: source,
          maxBuffer: 64 * 1024 * 1024,
        });
      const outputs = await findOutputs(join(temp, 'outputs'));
      if (!outputs.length) throw new Error('Gradle produced no APK or AAB');
      const staging = `${cache}.${randomUUID()}`;
      await mkdir(staging, { recursive: true });
      const names: string[] = [];
      for (const output of outputs) {
        const name = relative(join(temp, 'outputs'), output).replaceAll(
          '\\',
          '/',
        );
        await mkdir(dirname(join(staging, name)), { recursive: true });
        await copyFile(output, join(staging, name));
        names.push(name);
      }
      let versionCode: number | null = null;
      for (const output of outputs.filter((item) => item.endsWith('.apk'))) {
        try {
          const metadata = JSON.parse(
            await readFile(
              join(dirname(output), 'output-metadata.json'),
              'utf8',
            ),
          ) as { elements?: { versionCode?: number }[] };
          versionCode = metadata.elements?.[0]?.versionCode ?? versionCode;
        } catch {
          /* Metadata is not guaranteed for test APKs. */
        }
      }
      let signingDigest: string | null = null;
      const apk = outputs.find(
        (item) => item.endsWith('.apk') && !item.includes('androidTest'),
      );
      if (apk) {
        try {
          const sdk =
            options.sdkRoot ??
            process.env.ANDROID_SDK_ROOT ??
            process.env.ANDROID_HOME;
          let signer = 'apksigner';
          if (sdk) {
            const versions = (await readdir(join(sdk, 'build-tools'))).sort(
              (a, b) => b.localeCompare(a, undefined, { numeric: true }),
            );
            if (versions[0])
              signer = join(
                sdk,
                'build-tools',
                versions[0],
                process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
              );
          }
          const result =
            process.platform === 'win32'
              ? await execFile(
                  process.env.ComSpec ?? 'cmd.exe',
                  [
                    '/d',
                    '/s',
                    '/c',
                    `""${signer}" verify --print-certs "${apk}""`,
                  ],
                  { windowsVerbatimArguments: true },
                )
              : await execFile(signer, ['verify', '--print-certs', apk]);
          signingDigest =
            /Signer #1 certificate SHA-256 digest:\s*([\da-f:]+)/i
              .exec(result.stdout)?.[1]
              ?.replaceAll(':', '')
              .toLowerCase() ?? null;
        } catch {
          /* Unsigned builds have no signing certificate. */
        }
      }
      record = { files: names, versionCode, signingDigest };
      await writeFile(join(staging, 'result.json'), JSON.stringify(record));
      await rm(cache, { recursive: true, force: true });
      await rename(staging, cache);
    }
    const artifactDir = runArtifactDir(root, options.runId, 'emu-lab');
    const artifacts: string[] = [];
    for (const file of record.files) {
      const target = join(artifactDir, 'build', file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(cache, file), target);
      artifacts.push(relative(root, target).replaceAll('\\', '/'));
    }
    await writeArtifactIndex(root, options.runId, 'emu-lab', artifacts);
    return {
      artifacts,
      versionCode: record.versionCode,
      signingDigest: record.signingDigest,
      cacheKey: key,
      cached,
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    if (releaseUnlock) await releaseUnlock();
    await unlock();
  }
}
