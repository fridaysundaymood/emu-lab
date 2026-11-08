import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.env.AK_INTEGRATION !== '1') {
  console.log(
    'Set AK_INTEGRATION=1 to run the recovery and release integration.',
  );
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, '../kit-fixture-app');
const { Scheduler } = await import('../dist/core/scheduler.js');
const { build } = await import('../dist/core/build.js');
const { install, smokeRelease } = await import('../dist/core/runners.js');
const { runArtifactDir, writeArtifactIndex } = await import(
  '@budaknyenyel/kit-schema'
);
const runId = randomUUID();
const output = runArtifactDir(fixture, runId, 'emu-lab');
const evidence = {
  runId,
  builds: {},
  recovery: {},
  releaseSmoke: null,
  cleanup: {},
};
const scratch = await mkdtemp(join(tmpdir(), 'emu-lab-recovery-'));
const signingDir = join(scratch, 'signing');
const execFile = promisify(execFileCallback);
const runTool = (tool, args) =>
  process.platform === 'win32' && tool.endsWith('.bat')
    ? execFile(
        process.env.ComSpec ?? 'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `""${tool}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
        ],
        { windowsVerbatimArguments: true },
      )
    : execFile(tool, args);
const options = {
  databasePath: join(scratch, 'lab.sqlite'),
  budget: 1,
  headless: true,
  bootTimeoutMs: 480_000,
};
let scheduler;
let lease;
let failure;
try {
  await mkdir(output, { recursive: true });
  for (const variant of ['cleanRelease', 'cleanDebug']) {
    const first = await build({
      projectRoot: fixture,
      runId: `${runId}-${variant}-first`,
      variant,
    });
    const second = await build({
      projectRoot: fixture,
      runId: `${runId}-${variant}-cached`,
      variant,
    });
    evidence.builds[variant] = { first, second };
    assert.equal(second.cached, true, `${variant} second build must use cache`);
    assert.equal(second.cacheKey, first.cacheKey);
    assert.ok(second.artifacts.length, `${variant} must produce artifacts`);
  }

  const release = evidence.builds.cleanRelease.second;
  const apk = release.artifacts.find(
    (path) => path.endsWith('.apk') && !/androidTest/i.test(path),
  );
  let smokeApk = apk && resolve(fixture, apk);
  let signer = release.signingDigest;
  let apksigner;
  if (smokeApk && !signer) {
    const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
    if (!sdk)
      throw new Error(
        'ANDROID_SDK_ROOT or ANDROID_HOME is required to sign the unsigned release APK',
      );
    const versions = (await readdir(join(sdk, 'build-tools'))).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    assert.ok(
      versions.length,
      'Android SDK build-tools are required to sign the release APK',
    );
    const tools = join(sdk, 'build-tools', versions[0]);
    apksigner = join(
      tools,
      process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
    );
    const zipalign = join(
      tools,
      process.platform === 'win32' ? 'zipalign.exe' : 'zipalign',
    );
    const keytool = process.env.JAVA_HOME
      ? join(
          process.env.JAVA_HOME,
          'bin',
          process.platform === 'win32' ? 'keytool.exe' : 'keytool',
        )
      : 'keytool';
    await mkdir(signingDir, { recursive: true });
    const keystore = join(signingDir, 'fixture.p12');
    const aligned = join(signingDir, 'aligned.apk');
    const signed = join(signingDir, 'signed.apk');
    await runTool(keytool, [
      '-genkeypair',
      '-keystore',
      keystore,
      '-storetype',
      'PKCS12',
      '-storepass',
      'fixture-only',
      '-keypass',
      'fixture-only',
      '-alias',
      'fixture',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '1',
      '-dname',
      'CN=Emu Lab Synthetic Fixture',
    ]);
    await runTool(zipalign, ['-f', '4', smokeApk, aligned]);
    await runTool(apksigner, [
      'sign',
      '--ks',
      keystore,
      '--ks-key-alias',
      'fixture',
      '--ks-pass',
      'pass:fixture-only',
      '--key-pass',
      'pass:fixture-only',
      '--out',
      signed,
      aligned,
    ]);
    const verified = await runTool(apksigner, [
      'verify',
      '--print-certs',
      signed,
    ]);
    signer = /Signer #1 certificate SHA-256 digest:\s*([\da-f:]+)/i
      .exec(verified.stdout)?.[1]
      ?.replaceAll(':', '')
      .toLowerCase();
    assert.ok(signer, 'signed fixture APK must have a verified signer digest');
    smokeApk = signed;
    evidence.releaseSigning = {
      synthetic: true,
      signer,
      note: 'Temporary test key; this does not verify production release signing.',
    };
  }
  scheduler = new Scheduler(options);
  lease = await scheduler.lease({
    ttlMs: 60 * 60_000,
    heartbeatMs: 30 * 60_000,
  });
  evidence.recovery.lease = lease;
  assert.equal(
    await scheduler.authorize(lease.leaseId, lease.serial),
    lease.serial,
  );
  scheduler.close();
  scheduler = undefined;
  scheduler = new Scheduler(options);
  assert.equal(
    await scheduler.authorize(lease.leaseId, lease.serial),
    lease.serial,
  );
  evidence.recovery.authorizedAfterReopen = true;
  let invoked = false;
  await assert.rejects(
    scheduler.withLease(lease.leaseId, 'unowned-serial', async () => {
      invoked = true;
    }),
    /lease is not active or does not contain the requested device/,
  );
  assert.equal(invoked, false, 'foreign serial must not reach device callback');
  await assert.rejects(
    scheduler.authorize(randomUUID(), lease.serial),
    /lease does not authorize/,
  );
  evidence.recovery.foreignSerialDenied = true;
  evidence.recovery.foreignLeaseDenied = true;
  evidence.recovery.heartbeat = await scheduler.heartbeat(lease.leaseId);
  assert.ok(evidence.recovery.heartbeat.heartbeatDeadline > Date.now());
  assert.equal(
    await scheduler.authorize(lease.leaseId, lease.serial),
    lease.serial,
  );

  if (!smokeApk) {
    evidence.releaseSmoke = {
      status: 'blocked',
      reason:
        'The release build did not produce an installable APK; an AAB alone cannot be installed by this runner.',
      artifacts: release.artifacts,
    };
  } else {
    const device = { leaseId: lease.leaseId, serial: lease.serial };
    const packageName = 'dev.androidkit.fixture';
    evidence.releaseInstall = await install(scheduler, {
      ...device,
      packageName,
      apk: smokeApk,
      signer,
      ...(apksigner ? { apksigner } : {}),
    });
    evidence.releaseSmoke = await smokeRelease(scheduler, {
      ...device,
      packageName,
      artifactDir: output,
    });
    assert.equal(
      evidence.releaseSmoke.status,
      'pass',
      'release smoke must pass',
    );
  }
} catch (error) {
  failure = error;
  evidence.error = error instanceof Error ? error.stack : String(error);
} finally {
  try {
    if (lease) {
      if (!scheduler) scheduler = new Scheduler(options);
      await scheduler.release(lease.leaseId);
      evidence.cleanup.released = true;
    }
  } catch (error) {
    evidence.cleanup.error =
      error instanceof Error ? error.stack : String(error);
    failure ??= error;
  } finally {
    await rm(signingDir, { recursive: true, force: true });
    scheduler?.close();
    await mkdir(output, { recursive: true });
    const evidencePath = join(output, 'recovery-release.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    const files = [relative(fixture, evidencePath)];
    if (evidence.releaseSmoke?.artifacts) {
      for (const path of evidence.releaseSmoke.artifacts) {
        if (
          resolve(path).startsWith(
            `${resolve(output)}${process.platform === 'win32' ? '\\' : '/'}`,
          )
        )
          files.push(relative(fixture, path));
      }
    }
    await writeArtifactIndex(fixture, runId, 'emu-lab', files);
    if (!lease || evidence.cleanup.released)
      await rm(scratch, { recursive: true, force: true });
    else
      console.error(
        `Lease cleanup failed; scheduler database retained at ${options.databasePath}`,
      );
  }
}
console.log(`Recovery and release evidence: ${output}`);
if (evidence.releaseSmoke?.status === 'blocked')
  console.log(`Release smoke blocked: ${evidence.releaseSmoke.reason}`);
if (failure) throw failure;
