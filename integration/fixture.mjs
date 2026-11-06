import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AK_INTEGRATION !== '1') {
  console.log('Set AK_INTEGRATION=1 to run the emulator fixture integration.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, '../kit-fixture-app');
const { Scheduler } = await import('../dist/core/scheduler.js');
const { install, logcat, runInstrumentation, runMaestro } = await import(
  '../dist/core/runners.js'
);
const { classifyFailure } = await import('../dist/core/classifier.js');
const { build } = await import('../dist/core/build.js');
const { runArtifactDir, writeArtifactIndex } = await import(
  '@android-kit/schema'
);
const runId = randomUUID();
const builds = {};
for (const flavor of ['clean', 'defects']) {
  const variant = `${flavor}Debug`;
  const first = await build({
    projectRoot: fixture,
    runId: `${runId}-${flavor}-first`,
    variant,
  });
  const second = await build({
    projectRoot: fixture,
    runId: `${runId}-${flavor}-cached`,
    variant,
  });
  assert.equal(second.cached, true, `${variant} second build must use cache`);
  assert.equal(second.cacheKey, first.cacheKey);
  const paths = second.artifacts.map((path) => resolve(fixture, path));
  const apk = paths.find(
    (path) => path.endsWith('.apk') && !/androidTest/i.test(path),
  );
  const testApk = paths.find(
    (path) => path.endsWith('.apk') && /androidTest/i.test(path),
  );
  assert.ok(apk && testApk, `${variant} must produce app and test APKs`);
  builds[flavor] = { apk, testApk };
}
const packageName = 'dev.androidkit.fixture';
const runner = `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`;
const apk = (flavor) => builds[flavor].apk;
const testApk = (flavor) => builds[flavor].testApk;
const artifacts = runArtifactDir(fixture, runId, 'emu-lab');
const scratch = await mkdtemp(join(tmpdir(), 'emu-lab-integration-'));
const scheduler = new Scheduler({
  databasePath: join(scratch, 'lab.sqlite'),
  budget: 1,
});
let lease;
let heartbeat;
try {
  lease = await scheduler.lease({
    ttlMs: 60 * 60_000,
    heartbeatMs: 5 * 60_000,
  });
  heartbeat = setInterval(() => {
    void scheduler.heartbeat(lease.leaseId).catch(console.error);
  }, 60_000);
  const device = { leaseId: lease.leaseId, serial: lease.serial };
  const base = {
    ...device,
    packageName,
    artifactDir: join(artifacts, 'clean'),
    maestro: process.env.MAESTRO_PATH,
  };
  await install(scheduler, { ...device, packageName, apk: apk('clean') });
  const clean = await runInstrumentation(scheduler, {
    ...base,
    runner,
    testApk: testApk('clean'),
  });
  assert.equal(
    clean.status,
    'pass',
    `Clean instrumentation: ${JSON.stringify(clean)}`,
  );
  assert.ok(clean.count > 0, 'Clean instrumentation ran no tests');
  const launch = await runMaestro(scheduler, {
    ...base,
    flows: [join(fixture, 'e2e', 'maestro', '01-launch.yaml')],
  });
  assert.equal(
    launch.status,
    'pass',
    `Clean Maestro: ${JSON.stringify(launch)}`,
  );

  await install(scheduler, { ...device, packageName, apk: apk('defects') });
  const leak = await runInstrumentation(scheduler, {
    ...base,
    artifactDir: join(artifacts, 'state-leak'),
    runner,
    testApk: testApk('defects'),
    filter: 'dev.androidkit.fixture.StateLeakTest#testB_requiresPreviousTest',
  });
  assert.equal(
    leak.status,
    'fail',
    `State leak must fail in isolation: ${JSON.stringify(leak)}`,
  );
  const leakVerdict = classifyFailure({
    log: leak.output,
    resetExpected: true,
    artifacts: leak.artifacts,
    appPackage: packageName,
  });
  assert.equal(
    leakVerdict.classification,
    'test',
    `State leak classification: ${JSON.stringify(leakVerdict)}`,
  );

  const crashDir = join(artifacts, 'crash');
  await mkdir(crashDir, { recursive: true });
  const crashFlow = join(crashDir, 'crash.yaml');
  await writeFile(
    crashFlow,
    `appId: ${packageName}\n---\n- launchApp\n- tapOn:\n    point: "93%,9%"\n- tapOn: "Crash test"\n- assertVisible: "Crash test"\n`,
  );
  const crash = await runMaestro(scheduler, {
    ...base,
    artifactDir: crashDir,
    flows: [crashFlow],
  });
  assert.equal(
    crash.status,
    'fail',
    `Crash flow must fail: ${JSON.stringify(crash)}`,
  );
  const logs = await logcat(scheduler, {
    ...device,
    path: join(crashDir, 'logcat.txt'),
  });
  assert.match(
    logs.output,
    /Synthetic crash/,
    'Expected fixture crash in logcat',
  );
  const crashVerdict = classifyFailure({
    log: logs.output,
    artifacts: [logs.path],
    appPackage: packageName,
  });
  assert.equal(
    crashVerdict.classification,
    'app',
    `Crash classification: ${JSON.stringify(crashVerdict)}`,
  );
  console.log('Fixture integration passed.');
} finally {
  clearInterval(heartbeat);
  try {
    if (lease) await scheduler.release(lease.leaseId);
  } finally {
    scheduler.close();
    const collect = async (directory) => {
      const files = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await collect(path)));
        else if (entry.isFile() && entry.name !== 'index.json')
          files.push(relative(fixture, path));
      }
      return files;
    };
    await mkdir(artifacts, { recursive: true });
    await writeArtifactIndex(
      fixture,
      runId,
      'emu-lab',
      await collect(artifacts),
    );
    await rm(scratch, { recursive: true, force: true });
  }
}
