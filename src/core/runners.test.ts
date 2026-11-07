import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  type LeaseAuthorizer,
  runInstrumentation,
  runMaestro,
  smokeRelease,
} from './runners.js';

async function executable(dir: string, name: string, script: string) {
  const source = join(dir, `${name}.cjs`);
  await writeFile(source, script);
  const path = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  if (process.platform === 'win32') {
    await writeFile(
      path,
      `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`,
    );
  } else {
    await writeFile(
      path,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(source)} "$@"\n`,
    );
    await chmod(path, 0o755);
  }
  return path;
}

function authorizer(): LeaseAuthorizer {
  return {
    async authorize(leaseId, serial) {
      expect(leaseId).toBe('lease-1');
      expect(serial).toBe('emulator-5554');
      return 'emulator-5554';
    },
    async withLease(leaseId, serial, callback) {
      expect(leaseId).toBe('lease-1');
      expect(serial).toBe('emulator-5554');
      return callback('emulator-5554', new AbortController().signal);
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'emu-lab-runners-'));
  const calls = join(dir, 'calls.jsonl');
  const adb = await executable(
    dir,
    'adb',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(['adb', ...args]) + '\\n');
if (args.includes('instrument')) console.log('OK (0 tests)\\n<empty & done>');
if (args.includes('cat')) console.log('<hierarchy><node text="failure"/></hierarchy>');
if (args.includes('screencap')) process.stdout.write(Buffer.from('fake-png'));
`,
  );
  return {
    dir,
    calls,
    adb,
    artifactDir: join(dir, 'artifacts'),
    leaseId: 'lease-1',
    serial: 'emulator-5554',
    packageName: 'com.example.app',
  };
}

it('fails instrumentation reporting zero tests and writes its XML report', async () => {
  const f = await fixture();
  try {
    const result = await runInstrumentation(authorizer(), {
      ...f,
      runner: 'com.example.app.test/androidx.test.runner.AndroidJUnitRunner',
    });
    expect(result.status).toBe('fail');
    if (!('count' in result)) throw new Error('Instrumentation did not run');
    expect(result.count).toBe(0);
    const report = join(f.artifactDir, 'instrumentation.xml');
    expect(result.artifacts).toEqual([report]);
    const xml = await readFile(report, 'utf8');
    expect(xml).toContain('tests="0" failures="1"');
    expect(xml).toContain('No tests completed');
    expect(xml).toContain('&lt;empty &amp; done&gt;');
    const calls = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((call) => call.includes('instrument'))).toBe(true);
    expect(
      calls.every((call) => call[1] === '-s' && call[2] === f.serial),
    ).toBe(true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}, 120_000);

it('captures a failed Maestro run and reports flaky after a reset and passing rerun', async () => {
  const f = await fixture();
  try {
    const maestro = await executable(
      f.dir,
      'maestro',
      `
const fs = require('node:fs');
const calls = ${JSON.stringify(f.calls)};
const previous = fs.readFileSync(calls, 'utf8').split('\\n').filter(line => line.startsWith('["maestro"')).length;
fs.appendFileSync(calls, JSON.stringify(['maestro', ...process.argv.slice(2)]) + '\\n');
if (previous === 0) { console.log('first run failed'); console.error('selector missing'); process.exit(1); }
console.log('isolated rerun passed');
`,
    );
    const flow = join(f.dir, 'flow.yaml');
    await writeFile(flow, 'appId: com.example.app\n---\n- launchApp\n');
    const result = await runMaestro(authorizer(), {
      ...f,
      maestro,
      flows: [flow],
    });
    expect(result.status).toBe('flaky');
    if (!('results' in result)) throw new Error('Maestro did not run');
    expect(result.results).toHaveLength(1);
    const flowResult = result.results[0]!;
    expect(flowResult.status).toBe('flaky');
    expect(flowResult.flow).toBe(flow);
    const dir = join(f.artifactDir, 'flow-1');
    const hierarchy = join(dir, 'hierarchy.txt');
    const screenshot = join(dir, 'screenshot.png');
    const output = join(dir, 'output.txt');
    expect(flowResult.artifacts).toEqual([hierarchy, screenshot, output]);
    expect(await readFile(hierarchy, 'utf8')).toContain('<hierarchy>');
    expect(await readFile(screenshot, 'utf8')).toBe('fake-png');
    expect(await readFile(output, 'utf8')).toContain('first run failed');
    expect(await readFile(output, 'utf8')).toContain('selector missing');
    const calls = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const runs = calls.flatMap((call, index) =>
      call[0] === 'maestro' ? [index] : [],
    );
    expect(runs).toHaveLength(2);
    expect(calls[runs[0]!]!.slice(1)).toEqual([
      '--device',
      f.serial,
      'test',
      '--debug-output',
      dir,
      flow,
    ]);
    expect(calls[runs[1]!]!.slice(1)).toEqual([
      '--device',
      f.serial,
      'test',
      '--debug-output',
      dir,
      flow,
    ]);
    const between = calls.slice(runs[0]! + 1, runs[1]!);
    expect(between.some((call) => call.includes('screencap'))).toBe(true);
    expect(between.some((call) => call.includes('clear'))).toBe(true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}, 120_000);

it('selects the exact package UID for release smoke logcat', async () => {
  const f = await fixture();
  try {
    const adb = await executable(
      f.dir,
      'smoke-adb',
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify(args) + '\\n');
if (args.includes('packages')) console.log('package:com.example.app.other uid:99999\\npackage:com.example.app uid:10234');
if (args.includes('logcat')) console.log('app started');
`,
    );
    const result = await smokeRelease(authorizer(), { ...f, adb });
    expect(result.status).toBe('pass');
    if (!('artifacts' in result)) throw new Error('Smoke test did not run');
    const log = join(f.artifactDir, 'smoke-logcat.txt');
    expect(result.artifacts).toEqual([log]);
    expect(await readFile(log, 'utf8')).toContain('app started');
    const calls = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(
      calls.some(
        (call) =>
          call.includes('packages') &&
          call.includes('-U') &&
          call.includes(f.packageName),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.includes('logcat') &&
          call[call.indexOf('--uid') + 1] === '10234',
      ),
    ).toBe(true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}, 120_000);

it('rejects a UID belonging only to a similarly named package', async () => {
  const f = await fixture();
  try {
    const adb = await executable(
      f.dir,
      'missing-uid-adb',
      `
const args = process.argv.slice(2);
if (args.includes('packages')) console.log('package:com.example.app.other uid:99999');
`,
    );
    await expect(smokeRelease(authorizer(), { ...f, adb })).rejects.toThrow(
      'App UID unavailable',
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}, 120_000);
