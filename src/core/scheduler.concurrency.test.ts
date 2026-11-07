import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from './scheduler.js';

const host = Scheduler.prototype as unknown as {
  portFree(port: number): Promise<boolean>;
  provision(row: unknown): Promise<void>;
  verified(row: unknown): Promise<boolean>;
  liveness(row: unknown): Promise<string | undefined>;
  processMatches(row: unknown): Promise<boolean>;
};
const schedulers: Scheduler[] = [];
const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(host, 'portFree').mockResolvedValue(true);
  vi.spyOn(host, 'provision').mockResolvedValue(undefined);
  vi.spyOn(host, 'verified').mockResolvedValue(true);
  vi.spyOn(host, 'liveness').mockResolvedValue(undefined);
  vi.spyOn(host, 'processMatches').mockResolvedValue(false);
});

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function database() {
  const root = await mkdtemp(join(tmpdir(), 'emu-scheduler-clients-'));
  roots.push(root);
  return { root, databasePath: join(root, 'lab.sqlite') };
}

function client(databasePath: string, budget = 1) {
  const scheduler = new Scheduler({ databasePath, budget });
  schedulers.push(scheduler);
  return scheduler;
}

describe('independent scheduler clients', () => {
  it('shares the SQLite budget while a competing reservation is queued', async () => {
    const { databasePath } = await database();
    const first = client(databasePath);
    const second = client(databasePath);
    await Promise.all([first.status(), second.status()]);
    const lease = await first.lease();

    const { promise: scannedPorts, resolve: scanned } =
      Promise.withResolvers<void>();
    vi.mocked(host.portFree).mockImplementation(async function (
      this: unknown,
      port,
    ) {
      if (this === second && port === 5598) scanned();
      return true;
    });
    const waiting = second.lease();
    await scannedPorts;
    expect((await second.status()).queued).toBe(1);
    expect(
      (await first.status()).devices.map((device) => device.leaseId),
    ).toEqual([lease.leaseId]);

    vi.spyOn(process, 'kill').mockReturnValue(true);
    await first.release(lease.leaseId);
    const next = await waiting;
    expect(next.leaseId).not.toBe(lease.leaseId);
    expect(
      (await first.status()).devices.map((device) => device.leaseId),
    ).toEqual([next.leaseId]);
  });

  it('renews both deadlines across clients and expires only after both pass', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { databasePath } = await database();
    const first = client(databasePath);
    const second = client(databasePath);
    await Promise.all([first.status(), second.status()]);
    const lease = await first.lease({ ttlMs: 100, heartbeatMs: 200 });

    now += 150;
    expect(await second.heartbeat(lease.leaseId)).toEqual({
      expiresAt: now + 100,
      heartbeatDeadline: now + 200,
    });
    now += 100;
    await expect(first.authorize(lease.leaseId)).resolves.toBe(lease.serial);
    now += 99;
    expect((await first.status()).devices[0]?.state).toBe('active');
    vi.mocked(host.verified).mockResolvedValue(false);
    now += 1;
    await expect(second.heartbeat(lease.leaseId)).rejects.toThrow(
      'lease is not active',
    );
    expect((await first.status()).devices[0]?.state).toBe('quarantined');
    await expect(second.authorize(lease.leaseId)).rejects.toThrow();
  });

  it('quarantines unverified ownership after restart without touching user files or processes', async () => {
    const { root, databasePath } = await database();
    const first = client(databasePath);
    const lease = await first.lease();
    const db = new DatabaseSync(databasePath);
    const row = db
      .prepare('SELECT avd FROM lab_devices WHERE lease_id=?')
      .get(lease.leaseId) as { avd: string };
    db.close();
    const avdPath = join(root, 'avd', `${row.avd}.avd`);
    await mkdir(avdPath, { recursive: true });
    await writeFile(join(avdPath, '.emu-lab-owner'), 'user-owned');
    await writeFile(join(avdPath, 'user-data'), 'keep');
    first.close();
    schedulers.splice(schedulers.indexOf(first), 1);

    vi.mocked(host.verified).mockRestore();
    vi.mocked(host.processMatches).mockResolvedValue(true);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const restarted = client(databasePath);
    expect((await restarted.status()).devices[0]?.state).toBe('quarantined');
    await expect(restarted.authorize(lease.leaseId)).rejects.toThrow();
    await expect(restarted.release(lease.leaseId)).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
    expect(await readFile(join(avdPath, 'user-data'), 'utf8')).toBe('keep');
    expect(await readFile(join(avdPath, '.emu-lab-owner'), 'utf8')).toBe(
      'user-owned',
    );
  });
});
