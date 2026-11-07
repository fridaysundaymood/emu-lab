import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostLoadError, Scheduler } from './scheduler.js';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return { ...original, cpus: vi.fn(original.cpus) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

// Replace only host-facing operations; reservations and recovery still use SQLite.
const host = Scheduler.prototype as unknown as {
  portFree(port: number): Promise<boolean>;
  provision(row: unknown): Promise<void>;
  verified(row: unknown): Promise<boolean>;
  liveness(row: unknown): Promise<string | undefined>;
  pidAlive(pid: number): boolean;
};
const schedulers: Scheduler[] = [];
const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(host, 'portFree').mockResolvedValue(true);
  vi.spyOn(host, 'provision').mockResolvedValue(undefined);
  vi.spyOn(host, 'verified').mockResolvedValue(true);
  vi.spyOn(host, 'liveness').mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  vi.mocked(os.cpus).mockReset();
  vi.mocked(fs.readFile).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function create(budget = 2) {
  const root = await mkdtemp(join(tmpdir(), 'emu-scheduler-'));
  roots.push(root);
  const databasePath = join(root, 'lab.sqlite');
  const scheduler = new Scheduler({ databasePath, budget });
  schedulers.push(scheduler);
  return { scheduler, databasePath };
}

describe('scheduler with fake host operations', () => {
  it('authorizes only group members and rejects foreign or ambiguous serials', async () => {
    const { scheduler } = await create();
    const group = await scheduler.leaseGroup({
      profiles: ['default', 'software'],
    });
    expect(new Set(group.serials).size).toBe(2);
    for (const serial of group.serials)
      await expect(scheduler.authorize(group.leaseId, serial)).resolves.toBe(
        serial,
      );
    await expect(scheduler.authorize(group.leaseId)).rejects.toThrow();
    await expect(
      scheduler.authorize(group.leaseId, 'emulator-9999'),
    ).rejects.toThrow();
    await expect(
      scheduler.authorize('foreign', group.serials[0]),
    ).rejects.toThrow();
  });

  it('rolls back every reservation if group provisioning fails', async () => {
    vi.spyOn(host, 'provision')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boot failed'));
    const { scheduler } = await create();
    await expect(
      scheduler.leaseGroup({ profiles: ['default', 'software'] }),
    ).rejects.toThrow('boot failed');
    expect((await scheduler.status()).devices).toEqual([]);
    await expect(
      scheduler.leaseGroup({ profiles: ['default', 'default', 'default'] }),
    ).rejects.toThrow();
    expect((await scheduler.status()).devices).toEqual([]);
  });

  it('recovers verified leases and quarantines ambiguous ownership on restart', async () => {
    const { scheduler, databasePath } = await create();
    const lease = await scheduler.lease();
    scheduler.close();
    schedulers.splice(schedulers.indexOf(scheduler), 1);
    const recovered = new Scheduler({ databasePath, budget: 2 });
    schedulers.push(recovered);
    await expect(recovered.authorize(lease.leaseId)).resolves.toBe(
      lease.serial,
    );
    recovered.close();
    schedulers.splice(schedulers.indexOf(recovered), 1);
    vi.spyOn(host, 'verified').mockResolvedValue(false);
    const ambiguous = new Scheduler({ databasePath, budget: 2 });
    schedulers.push(ambiguous);
    expect((await ambiguous.status()).devices[0]?.state).toBe('quarantined');
    await expect(ambiguous.authorize(lease.leaseId)).rejects.toThrow();
  });
  it('cleans dead quarantines on status only with an owner marker and vacant ports', async () => {
    const { scheduler, databasePath } = await create();
    await scheduler.lease();
    const db = new DatabaseSync(databasePath);
    const row = db.prepare('SELECT id, avd FROM lab_devices').get() as {
      id: string;
      avd: string;
    };
    db.prepare("UPDATE lab_devices SET state='quarantined', pid=4242").run();
    db.close();
    const dir = join(databasePath, '..', 'avd', `${row.avd}.avd`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, '.emu-lab-owner'), 'foreign');
    vi.spyOn(host, 'pidAlive').mockReturnValue(false);
    expect((await scheduler.status()).devices).toHaveLength(1);
    await fs.writeFile(join(dir, '.emu-lab-owner'), row.id);
    vi.mocked(host.portFree).mockResolvedValue(false);
    expect((await scheduler.status()).devices).toHaveLength(1);
    vi.mocked(host.portFree).mockResolvedValue(true);
    vi.mocked(host.pidAlive).mockReturnValue(true);
    expect((await scheduler.status()).devices).toHaveLength(1);
    vi.mocked(host.pidAlive).mockReturnValue(false);
    expect((await scheduler.status()).devices).toHaveLength(0);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('expires only after both deadlines and quarantines unverified devices', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { scheduler } = await create();
    const lease = await scheduler.lease({ ttlMs: 100, heartbeatMs: 200 });
    now += 150;
    await expect(scheduler.authorize(lease.leaseId)).resolves.toBe(
      lease.serial,
    );
    expect((await scheduler.status()).devices[0]?.state).toBe('active');
    vi.spyOn(host, 'verified').mockResolvedValue(false);
    now += 51;
    expect((await scheduler.status()).devices[0]?.state).toBe('quarantined');
    await expect(scheduler.authorize(lease.leaseId)).rejects.toThrow();
  });
});

describe('CPU gate and authenticated console', () => {
  it('rejects an overloaded host with measured environment evidence', async () => {
    const { scheduler } = await create();
    const cpu = (user: number, idle: number): os.CpuInfo => ({
      model: 'fake',
      speed: 1,
      times: { user, nice: 0, sys: 0, idle, irq: 0 },
    });
    vi.mocked(os.cpus)
      .mockReturnValueOnce([cpu(100, 100)])
      .mockReturnValueOnce([cpu(195, 105)]);
    const gate = scheduler as unknown as { checkCpuLoad(): Promise<void> };
    const error = await gate.checkCpuLoad().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostLoadError);
    expect(error).toMatchObject({ cpuLoad: 0.95, maxCpuLoad: 0.85 });
  });

  it('authenticates a verified lease and redacts the console token', async () => {
    const { scheduler, databasePath } = await create();
    const lease = await scheduler.lease();
    const commands: string[] = [];
    const server = createServer((socket) => {
      socket.write('Android Console: Authentication required\r\nOK\r\n');
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString();
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n');
          const command = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          commands.push(command);
          socket.write(
            command.startsWith('auth ')
              ? 'OK\r\n'
              : 'snapshot fake-secret\r\nOK\r\n',
          );
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing server address');
    const serial = `emulator-${address.port}`;
    const db = new DatabaseSync(databasePath);
    db.prepare('UPDATE lab_devices SET port=?, serial=? WHERE lease_id=?').run(
      address.port,
      serial,
      lease.leaseId,
    );
    db.close();
    const originalReadFile =
      await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(((
      path: Parameters<typeof fs.readFile>[0],
      ...args: unknown[]
    ) => {
      if (String(path).endsWith('.emulator_console_auth_token'))
        return Promise.resolve('fake-secret');
      return (
        originalReadFile.readFile as (...params: unknown[]) => Promise<unknown>
      )(path, ...args);
    }) as typeof fs.readFile);
    try {
      expect(await scheduler.snapshot(lease.leaseId, serial, 'list')).toBe(
        'snapshot [redacted]',
      );
      expect(commands).toEqual(['auth fake-secret', 'avd snapshot list']);
      vi.mocked(host.verified).mockResolvedValue(false);
      await expect(
        scheduler.snapshot(lease.leaseId, serial, 'delete', 'clean'),
      ).rejects.toThrow(/ownership|authorize/);
      expect(commands).toEqual(['auth fake-secret', 'avd snapshot list']);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
