import assert from 'node:assert/strict';
import { execFile as execFileCallback, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.env.AK_INTEGRATION !== '1') {
  console.log(
    'Set AK_INTEGRATION=1 to run the crash and snapshot integration.',
  );
  process.exit(0);
}

const { Scheduler } = await import('../dist/core/scheduler.js');
const { setDeviceState } = await import('../dist/core/runners.js');
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === '--lease-child') {
  const databasePath = process.argv[3];
  const scheduler = new Scheduler({
    databasePath,
    budget: 1,
    headless: true,
    bootTimeoutMs: 480_000,
  });
  try {
    const lease = await scheduler.lease({
      ttlMs: 60 * 60_000,
      heartbeatMs: 30 * 60_000,
    });
    await new Promise((resolveSend, reject) => {
      process.send({ lease, databasePath }, (error) =>
        error ? reject(error) : resolveSend(),
      );
    });
    // Stay alive until the parent forcibly terminates this process.
    setInterval(() => {}, 60_000);
  } catch (error) {
    if (process.connected)
      process.send({
        error: error instanceof Error ? error.stack : String(error),
      });
    process.exitCode = 1;
    scheduler.close();
  }
} else {
  const { runArtifactDir, writeArtifactIndex } = await import(
    '@android-kit/schema'
  );
  const fixture = resolve(dirname(script), '../../kit-fixture-app');
  const runId = randomUUID();
  const output = runArtifactDir(fixture, runId, 'emu-lab');
  const scratch = await mkdtemp(join(tmpdir(), 'emu-lab-crash-'));
  const options = {
    databasePath: join(scratch, 'lab.sqlite'),
    budget: 1,
    headless: true,
    bootTimeoutMs: 480_000,
  };
  const evidence = {
    runId,
    databasePath: options.databasePath,
    recovery: {},
    snapshot: {},
    cleanup: {},
  };
  const execFile = promisify(execFileCallback);
  let scheduler;
  let lease;
  let child;
  let childExited;
  let failure;
  try {
    await mkdir(output, { recursive: true });
    child = fork(script, ['--lease-child', options.databasePath], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    childExited = new Promise((resolveExit) =>
      child.once('exit', (code, signal) => resolveExit({ code, signal })),
    );
    const message = await new Promise((resolveMessage, reject) => {
      child.once('message', resolveMessage);
      child.once('error', reject);
      childExited.then((exit) =>
        reject(
          new Error(
            `Lease child exited before reporting: ${JSON.stringify(exit)}`,
          ),
        ),
      );
    });
    if (message.error) throw new Error(message.error);
    assert.equal(message.databasePath, options.databasePath);
    lease = message.lease;
    assert.ok(
      lease?.leaseId && lease?.serial,
      'child must report the lease and serial',
    );
    evidence.recovery.lease = lease;
    assert.equal(
      child.kill('SIGKILL'),
      true,
      'lease child must be forcibly terminated',
    );
    evidence.recovery.childExit = await childExited;
    assert.notEqual(
      evidence.recovery.childExit.code,
      0,
      'lease child must not exit normally',
    );
    scheduler = new Scheduler(options);
    assert.equal(
      await scheduler.authorize(lease.leaseId, lease.serial),
      lease.serial,
    );
    evidence.recovery.authorizedAfterCrash = true;

    const device = { leaseId: lease.leaseId, serial: lease.serial };
    const readScale = () =>
      scheduler.withLease(
        lease.leaseId,
        lease.serial,
        async (serial, signal) => {
          const result = await execFile(
            'adb',
            ['-s', serial, 'shell', 'settings', 'get', 'system', 'font_scale'],
            { signal },
          );
          return result.stdout.trim();
        },
      );
    const setScale = async (fontScale) => {
      const result = await setDeviceState(scheduler, {
        ...device,
        state: { fontScale },
      });
      assert.equal(result.status, 'pass', 'font scale change must succeed');
      return await readScale();
    };
    const name = `crash_${runId.replaceAll('-', '')}`;
    evidence.snapshot.name = name;
    evidence.snapshot.baseline = await setScale(1);
    assert.equal(Number(evidence.snapshot.baseline), 1);
    evidence.snapshot.save = await scheduler.snapshot(
      lease.leaseId,
      lease.serial,
      'save',
      name,
    );
    evidence.snapshot.mutated = await setScale(1.3);
    assert.equal(Number(evidence.snapshot.mutated), 1.3);
    evidence.snapshot.load = await scheduler.snapshot(
      lease.leaseId,
      lease.serial,
      'load',
      name,
    );
    evidence.snapshot.restored = await readScale();
    assert.equal(
      Number(evidence.snapshot.restored),
      1,
      'snapshot load must restore the saved font scale',
    );
    evidence.snapshot.delete = await scheduler.snapshot(
      lease.leaseId,
      lease.serial,
      'delete',
      name,
    );
    evidence.snapshot.listAfterDelete = await scheduler.snapshot(
      lease.leaseId,
      lease.serial,
      'list',
    );
    assert.ok(
      !evidence.snapshot.listAfterDelete.includes(name),
      'deleted snapshot must not be listed',
    );
  } catch (error) {
    failure = error;
    evidence.error = error instanceof Error ? error.stack : String(error);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExited;
    }
    try {
      if (lease) {
        scheduler ??= new Scheduler(options);
        await scheduler.release(lease.leaseId);
        evidence.cleanup.released = true;
      }
    } catch (error) {
      evidence.cleanup.error =
        error instanceof Error ? error.stack : String(error);
      failure ??= error;
    } finally {
      scheduler?.close();
      await mkdir(output, { recursive: true });
      const evidencePath = join(output, 'crash-snapshot.json');
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      await writeArtifactIndex(fixture, runId, 'emu-lab', [
        relative(fixture, evidencePath),
      ]);
      if (evidence.cleanup.released)
        await rm(scratch, { recursive: true, force: true });
      else
        console.error(`Scheduler database retained at ${options.databasePath}`);
    }
  }
  console.log(`Crash and snapshot evidence: ${output}`);
  if (failure) throw failure;
}
