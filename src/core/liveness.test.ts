import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceRun } from './index.js';
import { DeviceUnresponsiveError, Scheduler } from './scheduler.js';

// Host operations are faked; slot reservation and cleanup still run on SQLite.
const host = Scheduler.prototype as unknown as {
  command(file: string, args: string[], timeout?: number): Promise<string>;
  provision(row: {
    pid: number | null;
    id: string;
    avd: string;
  }): Promise<void>;
  verified(row: unknown): Promise<boolean>;
  processMatches(row: unknown): Promise<boolean>;
  portFree(port: number): Promise<boolean>;
  pidAlive(pid: number): boolean;
};
// Fake emulator state: `wedged` serials time out on every probe; `alive` is the emulator process.
const FAKE_PID = 4242;
const wedged = new Set<string>();
let alive = false;
const probeTimeouts: number[] = [];
const schedulers: Scheduler[] = [];
const roots: string[] = [];
let databasePath = '';

beforeEach(() => {
  wedged.clear();
  alive = false;
  probeTimeouts.length = 0;
  vi.spyOn(host, 'portFree').mockResolvedValue(true);
  vi.spyOn(host, 'verified').mockResolvedValue(true);
  vi.spyOn(host, 'processMatches').mockImplementation(async () => alive);
  vi.spyOn(host, 'pidAlive').mockImplementation(() => alive);
  // Mirror production: provision records the emulator pid on the row it was given.
  vi.spyOn(host, 'provision').mockImplementation(async (row) => {
    row.pid = FAKE_PID;
    const dir = join(databasePath, '..', 'avd', `${row.avd}.avd`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.emu-lab-owner'), row.id);
    alive = true;
    const db = new DatabaseSync(databasePath);
    db.prepare('UPDATE lab_devices SET pid=? WHERE id=?').run(FAKE_PID, row.id);
    db.close();
  });
  vi.spyOn(host, 'command').mockImplementation(async (file, args, timeout) => {
    if (!/adb(\.exe)?$/.test(file)) return '';
    const serial = args[1] ?? '';
    const shell = args.slice(3).join(' ');
    if (shell.startsWith('echo') || shell.startsWith('getprop')) {
      probeTimeouts.push(timeout ?? -1);
      if (wedged.has(serial))
        throw new Error('Command timed out after 5000 ms');
      return shell.startsWith('echo') ? 'ok\n' : '1\n';
    }
    return '';
  });
  // A kill ends the fake emulator; the next cold boot is healthy.
  vi.spyOn(process, 'kill').mockImplementation(() => {
    wedged.clear();
    alive = false;
    return true;
  });
});

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function create(budget: number) {
  const root = await mkdtemp(join(tmpdir(), 'emu-liveness-'));
  roots.push(root);
  databasePath = join(root, 'lab.sqlite');
  const scheduler = new Scheduler({
    databasePath,
    budget,
    sdkRoot: join(root, 'sdk'),
  });
  schedulers.push(scheduler);
  return scheduler;
}

describe('device liveness probe', () => {
  it('quarantines and kills a device that wedges at grant, freeing its budget', async () => {
    const scheduler = await create(1);
    wedged.add('emulator-5580');
    const error = await scheduler.lease().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceUnresponsiveError);
    expect(error).toMatchObject({ serial: 'emulator-5580', freed: true });
    expect(error).toHaveProperty(
      'message',
      expect.stringMatching(/adb liveness probe failed/),
    );
    expect(process.kill).toHaveBeenCalledWith(FAKE_PID, 'SIGTERM');
    expect((await scheduler.status()).devices).toEqual([]);
    // Budget was released: a healthy device can be leased next.
    await expect(scheduler.lease()).resolves.toMatchObject({
      serial: 'emulator-5580',
    });
    expect(probeTimeouts.every((ms) => ms === 5000)).toBe(true);
  });

  it('reacquires one fresh lease when a run-time probe fails', async () => {
    const scheduler = await create(1);
    const lease = await scheduler.lease();
    wedged.add(lease.serial);
    const run = vi.fn(async (target: Record<string, unknown>) => ({
      status: 'pass',
      leaseId: target.leaseId,
    }));
    const result = await deviceRun(
      scheduler,
      { leaseId: lease.leaseId, serial: lease.serial },
      run,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'pass',
      leaseId: expect.any(String),
      reacquired: { leaseId: expect.any(String) },
    });
    expect(result).not.toMatchObject({ leaseId: lease.leaseId });
  });

  it('returns environment with evidence when the reacquired device also fails', async () => {
    const scheduler = await create(2);
    const lease = await scheduler.lease();
    const probe = vi
      .spyOn(scheduler, 'probe')
      .mockRejectedValue(
        new DeviceUnresponsiveError(
          'default',
          lease.serial,
          'probe wedged',
          true,
        ),
      );
    const run = vi.fn();
    const result = await deviceRun(
      scheduler,
      { leaseId: lease.leaseId, serial: lease.serial },
      run,
    );
    expect(run).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'error',
      classification: 'environment',
      evidence: [{ evidence: 'probe wedged' }],
    });
  });

  it('keeps a device quarantined without killing when its identity is unverified', async () => {
    const scheduler = await create(1);
    const lease = await scheduler.lease();
    vi.mocked(host.verified).mockResolvedValue(false);
    wedged.add(lease.serial);
    // Authorization refuses unverified ownership before any liveness check or kill.
    await expect(scheduler.probe(lease.leaseId)).rejects.toThrow(
      /ownership|authorize/,
    );
    expect(process.kill).not.toHaveBeenCalled();
  });
});
