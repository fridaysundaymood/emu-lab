import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { cpus, freemem, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface DeviceProfile {
  image: string;
  api: number;
  ramMb: number;
  cores: number;
  gpu: 'auto' | 'host' | 'swiftshader_indirect';
  root: boolean;
  locale: string;
  density: number;
}

export const defaultProfiles: Record<string, DeviceProfile> = {
  default: {
    image: 'system-images;android-36;google_apis_playstore;x86_64',
    api: 36,
    ramMb: 2048,
    cores: 4,
    gpu: 'host',
    root: false,
    locale: 'en-US',
    density: 420,
  },
  software: {
    image: 'system-images;android-36;google_apis_playstore;x86_64',
    api: 36,
    ramMb: 2048,
    cores: 4,
    gpu: 'swiftshader_indirect',
    root: false,
    locale: 'en-US',
    density: 420,
  },
};

export interface HealthEvent {
  leaseId: string;
  serial: string;
  attempt: number;
  stage: string;
  timestamp: string;
  elapsedMs: number;
}

export interface DiagnosticEvent {
  leaseId: string;
  serial: string;
  attempt: number;
  timestamp: string;
  output: string;
}

class LocaleUnavailableError extends Error {}

export class HostLoadError extends Error {
  constructor(
    public readonly cpuLoad: number | null,
    public readonly maxCpuLoad: number,
  ) {
    super(
      cpuLoad === null
        ? 'CPU utilization could not be measured'
        : `CPU utilization ${Math.round(cpuLoad * 100)}% exceeds the ${Math.round(maxCpuLoad * 100)}% boot threshold`,
    );
    this.name = 'HostLoadError';
  }
}

export interface SchedulerOptions {
  databasePath: string;
  artifactDir?: string;
  budget?: number;
  denySerials?: string[];
  sdkRoot?: string;
  allowInstall?: boolean;
  profiles?: Record<string, DeviceProfile>;
  bootTimeoutMs?: number;
  headless?: boolean;
  maxCpuLoad?: number;
  onHealth?: (event: HealthEvent) => void;
  onDiagnostics?: (event: DiagnosticEvent) => void;
}
export interface LeaseRequest {
  profile?: string;
  ttlMs?: number;
  heartbeatMs?: number;
}
export interface GroupRequest {
  profiles: string[];
  ttlMs?: number;
  heartbeatMs?: number;
}
export interface Lease {
  leaseId: string;
  serial: string;
  expiresAt: number;
  heartbeatDeadline: number;
}
export interface GroupLease {
  leaseId: string;
  serials: string[];
  expiresAt: number;
  heartbeatDeadline: number;
}

type Row = {
  id: string;
  profile: string;
  avd: string;
  port: number;
  serial: string;
  pid: number | null;
  owner_pid: number;
  state: string;
  lease_id: string;
  expires_at: number;
  heartbeat_deadline: number;
  ttl_ms: number;
  heartbeat_ms: number;
};

export class Scheduler {
  private readonly db: DatabaseSync;
  private readonly budget: number;
  private readonly denied: Set<string>;
  private readonly sdk: string;
  private readonly home: string;
  private readonly artifactDir: string;
  private readonly profiles: Record<string, DeviceProfile>;
  private readonly bootTimeout: number;
  private readonly headless: boolean;
  private readonly allowInstall: boolean;
  private readonly onHealth: (event: HealthEvent) => void;
  private readonly onDiagnostics:
    | ((event: DiagnosticEvent) => void)
    | undefined;
  private readonly maxCpuLoad: number;
  private lastCpuLoad: number | null = null;
  private readonly ready: Promise<void>;
  private queued = 0;
  private timer: NodeJS.Timeout;
  private readonly work = new Map<string, AbortController>();

  constructor(options: SchedulerOptions) {
    this.budget =
      options.budget ??
      Math.min(
        Math.floor(freemem() / (4 * 1024 ** 3)),
        Math.floor(cpus().length / 3),
      );
    if (!Number.isInteger(this.budget) || this.budget < 0)
      throw new Error('budget must be a non-negative integer');
    this.denied = new Set(options.denySerials ?? []);
    this.sdk =
      options.sdkRoot ??
      process.env.ANDROID_SDK_ROOT ??
      process.env.ANDROID_HOME ??
      '';
    this.allowInstall = options.allowInstall ?? false;
    this.onDiagnostics = options.onDiagnostics;
    this.profiles = { ...defaultProfiles, ...options.profiles };
    this.bootTimeout = options.bootTimeoutMs ?? 300_000;
    this.headless = options.headless ?? true;
    this.maxCpuLoad = options.maxCpuLoad ?? 0.85;
    if (
      !Number.isFinite(this.maxCpuLoad) ||
      this.maxCpuLoad <= 0 ||
      this.maxCpuLoad > 1
    )
      throw new Error('maxCpuLoad must be greater than zero and at most one');
    this.onHealth =
      options.onHealth ??
      ((event) => {
        process.stderr.write(
          `${JSON.stringify({ event: 'emulator_health', ...event })}\n`,
        );
      });
    this.home = resolve(dirname(options.databasePath), 'avd');
    this.artifactDir =
      options.artifactDir ??
      join(dirname(resolve(options.databasePath)), 'runs', 'emulator');
    if (options.databasePath !== ':memory:')
      mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
    this.db = new DatabaseSync(options.databasePath, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lab_devices (
        id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, profile TEXT NOT NULL, avd TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL UNIQUE, serial TEXT NOT NULL UNIQUE, pid INTEGER,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL, heartbeat_deadline INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL, heartbeat_ms INTEGER NOT NULL, owner_pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lab_work (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, pid INTEGER NOT NULL);`);
    this.ready = this.recover();
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, 5000);
    this.timer.unref();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private rows(sql: string, ...args: (string | number)[]): Row[] {
    return this.db.prepare(sql).all(...args) as unknown as Row[];
  }

  private tool(...parts: string[]): string {
    if (!this.sdk)
      throw new Error('Android SDK not configured; set ANDROID_SDK_ROOT');
    const name = parts.pop()!;
    const suffix =
      process.platform === 'win32'
        ? name === 'sdkmanager'
          ? '.bat'
          : '.exe'
        : '';
    return join(this.sdk, ...parts, name + suffix);
  }

  private async command(
    file: string,
    args: string[],
    timeout = 30_000,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await exec(file, args, {
      timeout,
      windowsHide: true,
      ...(signal ? { signal } : {}),
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  }

  private async processMatches(row: Row): Promise<boolean> {
    if (!row.pid || this.denied.has(row.serial)) return false;
    try {
      let line: string;
      if (process.platform === 'win32') {
        line = await this.command('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${row.pid}').CommandLine`,
        ]);
      } else {
        line = await this.command('ps', ['-p', String(row.pid), '-o', 'args=']);
      }
      return (
        line.includes(row.avd) &&
        /(?:emulator|qemu)/i.test(line) &&
        line.includes(String(row.port))
      );
    } catch {
      return false;
    }
  }

  private async emulatorChild(
    row: Row,
    launcherPid: number,
  ): Promise<number | undefined> {
    try {
      const text = await this.command('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${launcherPid}' | Where-Object { $_.CreationDate -ge (Get-Date).AddMinutes(-2) } | Select-Object ProcessId,ExecutablePath,CommandLine) -Compress`,
      ]);
      const children = JSON.parse(text) as Array<{
        ProcessId: number;
        ExecutablePath: string | null;
        CommandLine: string | null;
      }>;
      const root = resolve(this.sdk, 'emulator', 'qemu').toLowerCase() + '\\';
      const matches = children.filter((child) => {
        const executable = child.ExecutablePath?.toLowerCase() ?? '';
        const command = child.CommandLine ?? '';
        return (
          executable.startsWith(root) &&
          /\\qemu-system-[a-z0-9_]+(?:-headless)?\.exe$/.test(executable) &&
          command.includes(`-avd ${row.avd} -port ${row.port}`) &&
          Number.isSafeInteger(child.ProcessId)
        );
      });
      return matches.length === 1 ? matches[0]!.ProcessId : undefined;
    } catch {
      return undefined;
    }
  }

  private async verified(row: Row): Promise<boolean> {
    if (!(await this.processMatches(row))) return false;
    try {
      if (
        (await readFile(
          join(this.home, `${row.avd}.avd`, '.emu-lab-owner'),
          'utf8',
        )) !== row.id
      )
        return false;
      for (const port of [row.port, row.port + 1]) {
        let listeners: string;
        if (process.platform === 'win32') {
          listeners = await this.command('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); foreach($id in $p) { $x=Get-CimInstance Win32_Process -Filter "ProcessId = $id"; "$id $($x.ParentProcessId)" }`,
          ]);
        } else {
          const pids = await this.command('lsof', [
            '-nP',
            `-iTCP:${port}`,
            '-sTCP:LISTEN',
            '-t',
          ]);
          const lines: string[] = [];
          for (const pid of pids.trim().split(/\s+/)) {
            if (!/^\d+$/.test(pid)) return false;
            lines.push(
              `${pid} ${(await this.command('ps', ['-p', pid, '-o', 'ppid='])).trim()}`,
            );
          }
          listeners = lines.join('\n');
        }
        const entries = listeners.trim().split(/\r?\n/).filter(Boolean);
        if (
          !entries.length ||
          !entries.every((line) => {
            const ids = line.trim().split(/\s+/).map(Number);
            return ids[0] === row.pid || ids[1] === row.pid;
          })
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async recover(): Promise<void> {
    for (const row of this.rows(
      "SELECT * FROM lab_devices WHERE state IN ('active','provisioning','cleaning')",
    )) {
      if (row.state === 'cleaning') {
        await this.cleanup(row);
        continue;
      }
      if (row.state === 'provisioning' && this.pidAlive(row.owner_pid))
        continue;
      if (row.state === 'provisioning' || !(await this.verified(row))) {
        this.db
          .prepare("UPDATE lab_devices SET state='quarantined' WHERE id=?")
          .run(row.id);
      }
    }
    await this.sweepRows();
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async portFree(port: number): Promise<boolean> {
    const servers = [createServer(), createServer()];
    try {
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i]!;
        const {
          promise,
          resolve: listening,
          reject,
        } = Promise.withResolvers<void>();
        server.once('error', reject);
        server.listen(
          { port: port + i, host: '127.0.0.1', exclusive: true },
          listening,
        );
        await promise;
      }
      return true;
    } catch {
      return false;
    } finally {
      for (const server of servers) if (server.listening) server.close();
    }
  }

  private async sweep(): Promise<void> {
    await this.ready;
    await this.sweepRows();
  }
  private async sweepRows(): Promise<void> {
    const now = Date.now();
    const expired = this.transaction(() => {
      const rows = this.rows(
        "SELECT * FROM lab_devices WHERE state='active' AND expires_at<=? AND heartbeat_deadline<=?",
        now,
        now,
      );
      this.db
        .prepare(
          "UPDATE lab_devices SET state='cleaning' WHERE state='active' AND expires_at<=? AND heartbeat_deadline<=?",
        )
        .run(now, now);
      return rows;
    });
    for (const row of expired) await this.cleanup(row);
  }

  private async cleanup(row: Row): Promise<void> {
    for (const [id, controller] of this.work) {
      const entry = this.db
        .prepare('SELECT lease_id FROM lab_work WHERE id=?')
        .get(id);
      if (entry?.lease_id === row.lease_id) controller.abort();
    }
    for (;;) {
      const entries = this.db
        .prepare('SELECT id,pid FROM lab_work WHERE lease_id=?')
        .all(row.lease_id) as unknown as Array<{ id: string; pid: number }>;
      for (const entry of entries)
        if (!this.pidAlive(entry.pid))
          this.db.prepare('DELETE FROM lab_work WHERE id=?').run(entry.id);
      if (
        !this.db
          .prepare('SELECT 1 FROM lab_work WHERE lease_id=?')
          .get(row.lease_id)
      )
        break;
      await delay(100);
    }
    if (!(await this.verified(row))) {
      this.db
        .prepare("UPDATE lab_devices SET state='quarantined' WHERE id=?")
        .run(row.id);
      return;
    }
    try {
      process.kill(row.pid!, 'SIGTERM');
      for (let i = 0; i < 100 && (await this.processMatches(row)); i++)
        await delay(100);
      if (await this.processMatches(row))
        throw new Error('emulator did not stop');
      await rm(join(this.home, `${row.avd}.avd`), {
        recursive: true,
        force: true,
      });
      await rm(join(this.home, `${row.avd}.ini`), { force: true });
      this.db.prepare('DELETE FROM lab_devices WHERE id=?').run(row.id);
    } catch {
      this.db
        .prepare("UPDATE lab_devices SET state='quarantined' WHERE id=?")
        .run(row.id);
    }
  }

  private validate(request: LeaseRequest): { ttl: number; heartbeat: number } {
    const ttl = request.ttlMs ?? 30 * 60_000;
    const heartbeat = request.heartbeatMs ?? 60_000;
    if (
      !Number.isSafeInteger(ttl) ||
      ttl <= 0 ||
      !Number.isSafeInteger(heartbeat) ||
      heartbeat <= 0
    )
      throw new Error('lease durations must be positive integer milliseconds');
    return { ttl, heartbeat };
  }

  private async checkCpuLoad(): Promise<void> {
    const before = cpus();
    await delay(1000);
    const after = cpus();
    let total = 0;
    let idle = 0;
    if (before.length === after.length && before.length > 0) {
      for (let i = 0; i < before.length; i++) {
        const a = before[i]!.times,
          b = after[i]!.times;
        const idleDelta = b.idle - a.idle;
        const totalDelta =
          b.user -
          a.user +
          (b.nice - a.nice) +
          (b.sys - a.sys) +
          idleDelta +
          (b.irq - a.irq);
        if (idleDelta < 0 || totalDelta < idleDelta) {
          total = 0;
          break;
        }
        total += totalDelta;
        idle += idleDelta;
      }
    }
    this.lastCpuLoad = total > 0 ? 1 - idle / total : null;
    if (this.lastCpuLoad === null || this.lastCpuLoad >= this.maxCpuLoad)
      throw new HostLoadError(this.lastCpuLoad, this.maxCpuLoad);
  }

  private async reserve(
    profiles: string[],
    ttl: number,
    heartbeat: number,
  ): Promise<Row[]> {
    if (
      !profiles.length ||
      profiles.length > this.budget ||
      profiles.length > 10
    )
      throw new Error(
        'requested group exceeds the host budget or available emulator ports',
      );
    for (const name of profiles) {
      const profile = this.profiles[name];
      if (!profile) throw new Error(`unknown profile: ${name}`);
      if (
        !/^system-images;android-\d+;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+$/.test(
          profile.image,
        ) ||
        !Number.isInteger(profile.api) ||
        !Number.isInteger(profile.ramMb) ||
        profile.ramMb <= 0 ||
        !Number.isInteger(profile.cores) ||
        profile.cores <= 0 ||
        !Number.isInteger(profile.density) ||
        profile.density <= 0 ||
        !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(profile.locale) ||
        !['auto', 'host', 'swiftshader_indirect'].includes(profile.gpu)
      )
        throw new Error(`invalid profile: ${name}`);
    }
    this.queued++;
    try {
      for (;;) {
        await this.sweepRows();
        const available = new Set<number>();
        for (let port = 5580; port <= 5598; port += 2)
          if (await this.portFree(port)) available.add(port);
        const reserved = this.transaction(() => {
          const occupied = this.rows(
            "SELECT * FROM lab_devices WHERE state IN ('active','provisioning','cleaning','quarantined')",
          );
          if (occupied.length + profiles.length > this.budget) return null;
          const ports = new Set(occupied.map((row) => row.port));
          const candidates = [...available].filter(
            (port) => !ports.has(port) && !this.denied.has(`emulator-${port}`),
          );
          if (candidates.length < profiles.length) return null;
          const leaseId = randomUUID();
          const now = Date.now();
          const rows: Row[] = [];
          for (const profile of profiles) {
            const port = candidates.shift()!;
            ports.add(port);
            const id = randomUUID();
            const row: Row = {
              id,
              lease_id: leaseId,
              profile,
              avd: `ak-emu-lab-${id.replaceAll('-', '')}`,
              port,
              serial: `emulator-${port}`,
              pid: null,
              owner_pid: process.pid,
              state: 'provisioning',
              expires_at: now + ttl,
              heartbeat_deadline: now + heartbeat,
              ttl_ms: ttl,
              heartbeat_ms: heartbeat,
            };
            this.db
              .prepare(
                'INSERT INTO lab_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                row.id,
                row.lease_id,
                row.profile,
                row.avd,
                row.port,
                row.serial,
                null,
                row.state,
                row.expires_at,
                row.heartbeat_deadline,
                ttl,
                heartbeat,
                process.pid,
              );
            rows.push(row);
          }
          return rows;
        });
        if (reserved) return reserved;
        await delay(250);
      }
    } finally {
      this.queued--;
    }
  }

  private async provision(row: Row): Promise<void> {
    const profile = this.profiles[row.profile]!;
    const image = join(this.sdk, ...profile.image.split(';'));
    try {
      await readFile(join(image, 'source.properties'));
    } catch {
      if (!this.allowInstall)
        throw new Error(
          `system image ${profile.image} is not installed; install it or explicitly allow sdkmanager`,
        );
      const manager = this.tool('cmdline-tools', 'latest', 'bin', 'sdkmanager');
      if (process.platform === 'win32') {
        if (/[%!"\r\n]/.test(manager))
          throw new Error('SDK path cannot be safely passed to sdkmanager');
        await exec(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `""${manager}" "${profile.image}""`],
          {
            timeout: 600_000,
            windowsHide: true,
            windowsVerbatimArguments: true,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } else {
        await this.command(manager, [profile.image], 600_000);
      }
      await readFile(join(image, 'source.properties'));
    }
    const dir = join(this.home, `${row.avd}.avd`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.emu-lab-owner'), row.id, { flag: 'wx' });
    await writeFile(
      join(this.home, `${row.avd}.ini`),
      `avd.ini.encoding=UTF-8\npath=${dir}\ntarget=android-${profile.api}\n`,
    );
    const imageParts = profile.image.split(';');
    const abi = imageParts[3]!;
    const tag = imageParts[2]!;
    await writeFile(
      join(dir, 'config.ini'),
      `avd.ini.encoding=UTF-8\nAvdId=${row.avd}\nabi.type=${abi}\nhw.cpu.arch=${abi}\ntag.id=${tag}\nPlayStore.enabled=${tag === 'google_apis_playstore' ? 'yes' : 'no'}\nimage.sysdir.1=${imageParts.join('/')}/\nhw.ramSize=${profile.ramMb}\nhw.cpu.ncore=${profile.cores}\nhw.gpu.enabled=yes\nhw.gpu.mode=${profile.gpu}\nhw.lcd.density=${profile.density}\nhw.lcd.width=1080\nhw.lcd.height=1920\ndisk.dataPartition.size=6G\n`,
    );
    let bootEvidence = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.checkCpuLoad();
      const started = Date.now();
      let previousStage = '';
      const report = (stage: string) => {
        if (stage === previousStage) return;
        previousStage = stage;
        this.onHealth({
          leaseId: row.lease_id,
          serial: row.serial,
          attempt: attempt + 1,
          stage,
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - started,
        });
      };
      await mkdir(this.artifactDir, { recursive: true });
      const logPath = join(this.artifactDir, `${row.id}-${attempt + 1}.log`);
      const log = await open(logPath, 'a');
      report(attempt ? 'cold_retry_start' : 'boot_start');
      const child = spawn(
        this.tool('emulator', 'emulator'),
        [
          '-avd',
          row.avd,
          '-port',
          String(row.port),
          '-gpu',
          profile.gpu,
          ...(this.headless ? ['-no-window'] : []),
          '-no-snapshot',
          ...(attempt ? ['-no-snapshot-load', '-wipe-data'] : []),
        ],
        {
          env: { ...process.env, ANDROID_AVD_HOME: this.home },
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          windowsHide: this.headless,
        },
      );
      await log.close();
      child.unref();
      let exited = false;
      let adopted = false;
      let diagnostics = '';
      const emitDiagnostics = async () => {
        if (!this.onDiagnostics) return;
        diagnostics = (await readFile(logPath, 'utf8').catch(() => '')).slice(
          -16_384,
        );
        let token = '';
        try {
          token = (
            await readFile(
              join(homedir(), '.emulator_console_auth_token'),
              'utf8',
            )
          ).trim();
        } catch {}
        const output = token
          ? diagnostics
              .split(token)
              .join('[redacted]')
              .replace(
                /(auth(?:entication)?\s+token\s*[:=]\s*)\S+/gi,
                '$1[redacted]',
              )
          : '[emulator output withheld: console token unavailable for redaction]';
        this.onDiagnostics({
          leaseId: row.lease_id,
          serial: row.serial,
          attempt: attempt + 1,
          timestamp: new Date().toISOString(),
          output,
        });
      };
      let exitDetails = '';
      child.on('exit', (code, signal) => {
        exitDetails = `exit code ${code}, signal ${signal}`;
        if (!adopted) exited = true;
      });
      child.on('error', (error) => {
        diagnostics = `${diagnostics}\n${error.message}`.slice(-16_384);
        if (!adopted) exited = true;
      });
      if (!child.pid) throw new Error('failed to start emulator');
      row.pid = child.pid;
      this.db
        .prepare('UPDATE lab_devices SET pid=? WHERE id=?')
        .run(row.pid, row.id);
      if (process.platform === 'win32') {
        const launcherPid = child.pid;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const pid = await this.emulatorChild(row, launcherPid);
          if (pid) {
            row.pid = pid;
            this.db
              .prepare('UPDATE lab_devices SET pid=? WHERE id=?')
              .run(pid, row.id);
            adopted = true;
            exited = false;
            break;
          }
          await delay(250);
        }
        if (!adopted) {
          await emitDiagnostics();
          throw new Error(
            'emulator child identity could not be established; device quarantined',
          );
        }
      }
      report('verifying_ownership');
      const end = Date.now() + this.bootTimeout;
      let healthEvidence = 'waiting for verified emulator ownership';
      while (
        Date.now() < end &&
        !exited &&
        (!adopted || this.pidAlive(row.pid))
      ) {
        if (!(await this.verified(row))) {
          healthEvidence =
            'emulator process or listening ports could not be verified';
          await delay(1000);
          continue;
        }
        try {
          healthEvidence = 'checking boot completion';
          report('checking_boot_completion');
          const adb = this.tool('platform-tools', 'adb');
          const boot = await this.command(
            adb,
            ['-s', row.serial, 'shell', 'getprop', 'sys.boot_completed'],
            5000,
          );
          if (boot.trim() !== '1') {
            healthEvidence = `sys.boot_completed=${boot.trim() || '(empty)'}`;
            await delay(1000);
            continue;
          }
          healthEvidence = 'checking package manager';
          report('checking_package_manager');
          await this.command(
            adb,
            ['-s', row.serial, 'shell', 'pm', 'path', 'android'],
            5000,
          );
          healthEvidence = 'checking System UI';
          report('checking_system_ui');
          const windows = await this.command(
            adb,
            ['-s', row.serial, 'shell', 'dumpsys', 'window', 'windows'],
            5000,
          );
          if (
            /Application Not Responding.*(?:System UI|systemui)/i.test(windows)
          ) {
            await this.command(
              adb,
              ['-s', row.serial, 'shell', 'input', 'keyevent', '4'],
              5000,
            );
            const recheck = await this.command(
              adb,
              ['-s', row.serial, 'shell', 'dumpsys', 'window', 'windows'],
              5000,
            );
            if (
              /Application Not Responding.*(?:System UI|systemui)/i.test(
                recheck,
              )
            )
              throw new Error('System UI is not responding');
          }
          healthEvidence = 'unlocking screen';
          report('unlocking_screen');
          await this.command(
            adb,
            ['-s', row.serial, 'shell', 'input', 'keyevent', '82'],
            5000,
          );
          healthEvidence = 'checking screen lock';
          report('checking_screen_lock');
          const policy = await this.command(
            adb,
            ['-s', row.serial, 'shell', 'dumpsys', 'window', 'policy'],
            5000,
          );
          if (/mShowingLockscreen=true|isStatusBarKeyguard=true/.test(policy))
            throw new Error('screen remains locked');
          healthEvidence = 'checking root requirement';
          report('checking_root');
          if (profile.root) {
            await this.command(adb, ['-s', row.serial, 'root'], 10_000);
            if (
              (
                await this.command(
                  adb,
                  ['-s', row.serial, 'shell', 'id', '-u'],
                  10_000,
                )
              ).trim() !== '0'
            )
              throw new Error('profile requires root');
          }
          healthEvidence = 'setting locale';
          report('setting_locale');
          const normalizeLocale = (value: string) =>
            value.trim().replaceAll('_', '-').toLowerCase();
          const readLocale = async () => {
            const persisted = (
              await this.command(
                adb,
                ['-s', row.serial, 'shell', 'getprop', 'persist.sys.locale'],
                5000,
              )
            ).trim();
            let effective = '';
            try {
              const dump = await this.command(
                adb,
                [
                  '-s',
                  row.serial,
                  'shell',
                  'dumpsys',
                  'activity',
                  'activities',
                ],
                10_000,
              );
              effective =
                /m(?:GlobalConfiguration|CurrentConfig)\s*=\s*\{[^\r\n]*?\[([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)/i.exec(
                  dump,
                )?.[1] ?? '';
            } catch {
              /* Fall back to system properties. */
            }
            if (effective) return effective;
            if (persisted) return persisted;
            return (
              await this.command(
                adb,
                ['-s', row.serial, 'shell', 'getprop', 'ro.product.locale'],
                5000,
              )
            ).trim();
          };
          const currentLocale = await readLocale();
          if (
            normalizeLocale(currentLocale) !== normalizeLocale(profile.locale)
          ) {
            try {
              await this.command(
                adb,
                [
                  '-s',
                  row.serial,
                  'shell',
                  'setprop',
                  'persist.sys.locale',
                  profile.locale,
                ],
                5000,
              );
              const updated = await readLocale();
              if (normalizeLocale(updated) !== normalizeLocale(profile.locale))
                throw new Error('locale was not changed');
            } catch {
              throw new LocaleUnavailableError(
                `requested locale ${profile.locale} cannot be set on this image`,
              );
            }
          }
          healthEvidence = 'setting display density';
          report('setting_density');
          await this.command(
            adb,
            [
              '-s',
              row.serial,
              'shell',
              'wm',
              'density',
              String(profile.density),
            ],
            5000,
          );
          report('ready');
          await emitDiagnostics();
          return;
        } catch (error) {
          if (error instanceof LocaleUnavailableError) {
            await emitDiagnostics();
            throw error;
          }
          report(`failed_${previousStage}`);
          healthEvidence =
            `${healthEvidence}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              4000,
            );
          await delay(1000);
        }
      }
      if (adopted && !this.pidAlive(row.pid)) exited = true;
      report(exited ? 'process_exited' : 'boot_timeout');
      await emitDiagnostics();
      if (exited) await delay(100);
      let token = '';
      try {
        token = (
          await readFile(
            join(homedir(), '.emulator_console_auth_token'),
            'utf8',
          )
        ).trim();
      } catch {}
      bootEvidence =
        `${exitDetails}\n${token ? healthEvidence.split(token).join('[redacted]') : healthEvidence}\n${token ? diagnostics.split(token).join('[redacted]') : '[emulator output withheld: console token unavailable for redaction]'}`.replace(
          /(auth(?:entication)?\s+token\s*[:=]\s*)\S+/gi,
          '$1[redacted]',
        );
      if (exited) {
        if (!(await this.portFree(row.port)))
          throw new Error(
            `emulator exited but its ports remain occupied; device quarantined. ${bootEvidence}`,
          );
        row.pid = null;
        this.db
          .prepare('UPDATE lab_devices SET pid=NULL WHERE id=?')
          .run(row.id);
        continue;
      }
      if (!(await this.verified(row)))
        throw new Error(
          `emulator identity could not be verified; device quarantined. ${bootEvidence}`,
        );
      process.kill(row.pid, 'SIGTERM');
      for (let i = 0; i < 100 && (await this.processMatches(row)); i++)
        await delay(100);
      if (await this.processMatches(row))
        throw new Error('failed to stop emulator for cold boot');
      row.pid = null;
      this.db.prepare('UPDATE lab_devices SET pid=NULL WHERE id=?').run(row.id);
    }
    throw new Error(
      `emulator ${row.avd} failed boot health checks after cold retry. ${bootEvidence}`,
    );
  }

  async lease(request: LeaseRequest = {}): Promise<Lease> {
    const group = await this.leaseGroup({
      profiles: [request.profile ?? 'default'],
      ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
      ...(request.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: request.heartbeatMs }),
    });
    return {
      leaseId: group.leaseId,
      serial: group.serials[0]!,
      expiresAt: group.expiresAt,
      heartbeatDeadline: group.heartbeatDeadline,
    };
  }

  async leaseGroup(request: GroupRequest): Promise<GroupLease> {
    await this.ready;
    const { ttl, heartbeat } = this.validate(request);
    const rows = await this.reserve(request.profiles, ttl, heartbeat);
    try {
      for (const row of rows) await this.provision(row);
      const now = Date.now();
      this.transaction(() => {
        for (const row of rows)
          this.db
            .prepare(
              "UPDATE lab_devices SET state='active', expires_at=?, heartbeat_deadline=? WHERE id=? AND state='provisioning'",
            )
            .run(now + ttl, now + heartbeat, row.id);
      });
      return {
        leaseId: rows[0]!.lease_id,
        serials: rows.map((row) => row.serial),
        expiresAt: now + ttl,
        heartbeatDeadline: now + heartbeat,
      };
    } catch (error) {
      for (const row of rows) {
        if (row.pid) await this.cleanup(row);
        else {
          const dir = join(this.home, `${row.avd}.avd`);
          try {
            if (
              (await readFile(join(dir, '.emu-lab-owner'), 'utf8')) === row.id
            ) {
              await rm(dir, { recursive: true, force: true });
              await rm(join(this.home, `${row.avd}.ini`), { force: true });
            }
          } catch {
            /* No verified AVD was created. */
          }
          this.db.prepare('DELETE FROM lab_devices WHERE id=?').run(row.id);
        }
      }
      throw error;
    }
  }

  async heartbeat(
    leaseId: string,
  ): Promise<{ expiresAt: number; heartbeatDeadline: number }> {
    await this.ready;
    return this.transaction(() => {
      const now = Date.now();
      const rows = this.rows(
        "SELECT * FROM lab_devices WHERE lease_id=? AND state='active'",
        leaseId,
      );
      if (
        !rows.length ||
        rows.some(
          (row) => row.expires_at <= now && row.heartbeat_deadline <= now,
        )
      )
        throw new Error('lease is not active');
      const row = rows[0]!;
      const expiresAt = now + row.ttl_ms,
        heartbeatDeadline = now + row.heartbeat_ms;
      this.db
        .prepare(
          "UPDATE lab_devices SET expires_at=?, heartbeat_deadline=? WHERE lease_id=? AND state='active'",
        )
        .run(expiresAt, heartbeatDeadline, leaseId);
      return { expiresAt, heartbeatDeadline };
    });
  }

  async authorize(leaseId: string, serial?: string): Promise<string> {
    await this.ready;
    const now = Date.now();
    const rows = this.rows(
      "SELECT * FROM lab_devices WHERE lease_id=? AND state='active' AND (expires_at>? OR heartbeat_deadline>?)",
      leaseId,
      now,
      now,
    );
    const row = serial
      ? rows.find((item) => item.serial === serial)
      : rows.length === 1
        ? rows[0]
        : undefined;
    if (!row || this.denied.has(row.serial) || !(await this.verified(row)))
      throw new Error(
        'lease does not authorize this device or ownership cannot be verified',
      );
    return row.serial;
  }

  async withLease<T>(
    leaseId: string,
    serial: string | undefined,
    callback: (serial: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.ready;
    const id = randomUUID();
    this.transaction(() => {
      const now = Date.now();
      const rows = this.rows(
        "SELECT * FROM lab_devices WHERE lease_id=? AND state='active' AND (expires_at>? OR heartbeat_deadline>?)",
        leaseId,
        now,
        now,
      );
      if (
        !(serial
          ? rows.some((row) => row.serial === serial)
          : rows.length === 1)
      )
        throw new Error(
          'lease is not active or does not contain the requested device',
        );
      this.db
        .prepare('INSERT INTO lab_work VALUES (?,?,?)')
        .run(id, leaseId, process.pid);
    });
    const controller = new AbortController();
    this.work.set(id, controller);
    const timer = setInterval(() => {
      const active = this.db
        .prepare(
          "SELECT 1 FROM lab_devices WHERE lease_id=? AND state='active'",
        )
        .get(leaseId);
      if (!active) controller.abort();
    }, 100);
    timer.unref();
    try {
      const authorized = await this.authorize(leaseId, serial);
      if (controller.signal.aborted) throw new Error('lease released');
      return await callback(authorized, controller.signal);
    } finally {
      clearInterval(timer);
      this.work.delete(id);
      this.db.prepare('DELETE FROM lab_work WHERE id=?').run(id);
    }
  }

  async snapshot(
    leaseId: string,
    serial: string | undefined,
    action: 'list' | 'save' | 'load' | 'delete',
    name?: string,
  ): Promise<string> {
    if (
      !['list', 'save', 'load', 'delete'].includes(action) ||
      (action === 'list'
        ? name !== undefined
        : !name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name))
    )
      throw new Error('invalid snapshot action or name');
    return this.withLease(leaseId, serial, async (authorized, signal) => {
      let token: string;
      try {
        token = (
          await readFile(
            join(homedir(), '.emulator_console_auth_token'),
            'utf8',
          )
        ).trim();
      } catch {
        throw new Error(
          'emulator console authentication token is unavailable; restore the local console token',
        );
      }
      if (!token || /[\r\n]/.test(token))
        throw new Error('emulator console authentication token is invalid');
      const row = this.rows(
        "SELECT * FROM lab_devices WHERE lease_id=? AND serial=? AND state='active'",
        leaseId,
        authorized,
      )[0];
      if (!row || !(await this.verified(row)))
        throw new Error('emulator ownership cannot be verified');
      const socket = createConnection({ host: '127.0.0.1', port: row.port });
      socket.pause();
      const {
        promise,
        resolve: finish,
        reject,
      } = Promise.withResolvers<string>();
      let buffer = '';
      let phase = 0;
      const abort = () => {
        reject(new Error('lease released during snapshot operation'));
        socket.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      socket.setTimeout(120_000, () => {
        reject(new Error('emulator console timed out'));
        socket.destroy();
      });
      socket.on('error', () =>
        reject(new Error('emulator console connection failed')),
      );
      socket.on('close', () =>
        reject(
          new Error(
            'emulator console closed before completing the snapshot operation',
          ),
        ),
      );
      socket.on('connect', () => {
        void this.verified(row).then(
          (verified) => {
            if (!verified || signal.aborted) {
              reject(new Error('emulator ownership cannot be verified'));
              socket.destroy();
              return;
            }
            socket.resume();
          },
          () => {
            reject(new Error('emulator ownership cannot be verified'));
            socket.destroy();
          },
        );
      });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 1_000_000) {
          reject(new Error('emulator console response too large'));
          socket.destroy();
          return;
        }
        const match = /(?:^|\r?\n)(OK|KO(?:[^\r\n]*)?)\r?\n/.exec(buffer);
        if (!match) return;
        const response = buffer.slice(0, match.index).trim();
        buffer = buffer.slice(match.index + match[0].length);
        if (match[1] !== 'OK') {
          reject(new Error('emulator console rejected the snapshot operation'));
          socket.destroy();
          return;
        }
        if (phase === 0) {
          phase = 1;
          socket.write(`auth ${token}\n`);
        } else if (phase === 1) {
          phase = 2;
          void this.verified(row).then(
            (verified) => {
              if (!verified || signal.aborted) {
                reject(new Error('emulator ownership cannot be verified'));
                socket.destroy();
                return;
              }
              socket.write(`avd snapshot ${action}${name ? ` ${name}` : ''}\n`);
            },
            () => {
              reject(new Error('emulator ownership cannot be verified'));
              socket.destroy();
            },
          );
        } else {
          finish(response.split(token).join('[redacted]'));
          socket.end();
        }
      });
      let result: string;
      try {
        result = await promise;
      } finally {
        signal.removeEventListener('abort', abort);
        socket.destroy();
      }
      if (action === 'load') {
        const adb = this.tool('platform-tools', 'adb');
        const deadline = Date.now() + this.bootTimeout;
        let ready = false;
        while (Date.now() < deadline && !signal.aborted) {
          try {
            if (!(await this.verified(row))) {
              await delay(1000, undefined, { signal });
              continue;
            }
            await this.command(
              adb,
              ['-s', authorized, 'wait-for-device'],
              Math.max(1, Math.min(5000, deadline - Date.now())),
              signal,
            );
            if (!(await this.verified(row))) {
              await delay(1000, undefined, { signal });
              continue;
            }
            const boot = await this.command(
              adb,
              ['-s', authorized, 'shell', 'getprop', 'sys.boot_completed'],
              Math.max(1, Math.min(5000, deadline - Date.now())),
              signal,
            );
            if (boot.trim() !== '1' || !(await this.verified(row))) {
              await delay(1000, undefined, { signal });
              continue;
            }
            await this.command(
              adb,
              ['-s', authorized, 'shell', 'pm', 'path', 'android'],
              Math.max(1, Math.min(5000, deadline - Date.now())),
              signal,
            );
            ready = true;
            break;
          } catch {
            if (signal.aborted)
              throw new Error(
                'lease released while waiting for snapshot restore',
              );
          }
          await delay(1000, undefined, { signal });
        }
        if (signal.aborted)
          throw new Error('lease released while waiting for snapshot restore');
        if (!ready)
          throw new Error(
            'snapshot loaded but device did not become booted and package-manager ready before timeout',
          );
      }
      return result;
    });
  }

  async release(leaseId: string): Promise<void> {
    await this.ready;
    const rows = this.transaction(() => {
      const found = this.rows(
        "SELECT * FROM lab_devices WHERE lease_id=? AND state='active'",
        leaseId,
      );
      if (!found.length) throw new Error('lease is not active');
      this.db
        .prepare(
          "UPDATE lab_devices SET state='cleaning' WHERE lease_id=? AND state='active'",
        )
        .run(leaseId);
      return found;
    });
    for (const row of rows) await this.cleanup(row);
  }

  async status(): Promise<{
    budget: number;
    queued: number;
    cpuLoad: number | null;
    maxCpuLoad: number;
    devices: Array<{
      leaseId: string;
      serial: string;
      profile: string;
      state: string;
      expiresAt: number;
      heartbeatDeadline: number;
    }>;
  }> {
    await this.ready;
    await this.sweepRows();
    return {
      budget: this.budget,
      queued: this.queued,
      cpuLoad: this.lastCpuLoad,
      maxCpuLoad: this.maxCpuLoad,
      devices: this.rows('SELECT * FROM lab_devices').map((row) => ({
        leaseId: row.lease_id,
        serial: row.serial,
        profile: row.profile,
        state: row.state,
        expiresAt: row.expires_at,
        heartbeatDeadline: row.heartbeat_deadline,
      })),
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.db.close();
  }
}
