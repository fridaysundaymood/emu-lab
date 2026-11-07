import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from './build.js';

describe('isolated Gradle build cache', () => {
  it('reuses an unchanged worktree despite Kotlin sessions and rebuilds after a source change', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'emu-lab-cache-test-'));
    const root = join(temp, 'project');
    const count = join(temp, 'invocations');
    const tasks = join(temp, 'tasks');
    try {
      await mkdir(join(root, '.kotlin', 'sessions'), { recursive: true });
      await writeFile(join(root, 'source.txt'), 'first');
      const script = `const fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(tasks)}, JSON.stringify(args.slice(0, 2)) + '\\n');\nconst init = fs.readFileSync(args[args.indexOf('--init-script') + 1], 'utf8');\nconst output = /new File\\('([^']+)'/.exec(init)[1];\nconst dir = path.join(output, 'app', 'outputs', 'apk', 'debug');\nfs.mkdirSync(dir, {recursive:true});\nfs.writeFileSync(path.join(dir, 'app-debug.apk'), 'apk');\nfs.writeFileSync(path.join(dir, 'output-metadata.json'), JSON.stringify({elements:[{versionCode:7}]}));\nfs.appendFileSync(${JSON.stringify(count)}, 'run\\n');\n`;
      await writeFile(join(root, 'fake.cjs'), script);
      if (process.platform === 'win32') {
        await writeFile(
          join(root, 'gradlew.bat'),
          '@echo off\r\nnode "%~dp0fake.cjs" %*\r\n',
        );
      } else {
        await writeFile(
          join(root, 'gradlew'),
          '#!/bin/sh\nnode "$(dirname "$0")/fake.cjs" "$@"\n',
        );
        await chmod(join(root, 'gradlew'), 0o755);
      }
      const first = await build({
        projectRoot: root,
        runId: 'first',
        variant: 'debug',
      });
      await writeFile(
        join(root, '.kotlin', 'sessions', 'changed.salive'),
        'session',
      );
      const second = await build({
        projectRoot: root,
        runId: 'second',
        variant: 'debug',
      });
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.cacheKey).toBe(first.cacheKey);
      expect(second.versionCode).toBe(7);
      expect(await readFile(join(root, second.artifacts[0]!), 'utf8')).toBe(
        'apk',
      );
      expect(await readFile(count, 'utf8')).toBe('run\n');
      expect(JSON.parse((await readFile(tasks, 'utf8')).trim())).toEqual([
        ':app:assembleDebug',
        ':app:assembleDebugAndroidTest',
      ]);
      const differentTest = await build({
        projectRoot: root,
        runId: 'different-test',
        variant: 'debug',
        testVariant: 'demoDebug',
      });
      expect(differentTest.cached).toBe(false);
      expect(differentTest.cacheKey).not.toBe(first.cacheKey);
      expect(
        (await readFile(tasks, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        [':app:assembleDebug', ':app:assembleDebugAndroidTest'],
        [':app:assembleDebug', ':app:assembleDemoDebugAndroidTest'],
      ]);
      await writeFile(join(root, 'source.txt'), 'second');
      const third = await build({
        projectRoot: root,
        runId: 'third',
        variant: 'debug',
      });
      expect(third.cached).toBe(false);
      expect(third.cacheKey).not.toBe(first.cacheKey);
      expect(await readFile(count, 'utf8')).toBe('run\nrun\nrun\n');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
