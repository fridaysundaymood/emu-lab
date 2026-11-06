import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';

export interface LeaseAuthorizer {
  authorize(leaseId: string, serial?: string): Promise<string>;
  withLease<T>(
    leaseId: string,
    serial: string | undefined,
    callback: (serial: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
export interface DeviceArgs {
  leaseId: string;
  serial?: string;
  adb?: string;
}
export interface DeviceState {
  locale?: string;
  fontScale?: number;
  displaySize?: string;
  density?: number;
  clock?: string;
  darkMode?: boolean;
  batterySaver?: boolean;
  network?: { speed?: string; delay?: string };
  rotation?: number;
}
export interface RunnerArgs extends DeviceArgs {
  packageName: string;
  state?: DeviceState;
  artifactDir: string;
}
export type CommandResult = { code: number; stdout: string; stderr: string };

async function findWindowsCommand(program: string): Promise<string> {
  if (process.platform !== 'win32' || extname(program)) return program;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const candidate = join(directory, program + extension);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return program;
}

async function findApksigner(sdkRoot?: string): Promise<string> {
  const sdk =
    sdkRoot ?? process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  if (sdk) {
    const dir = join(sdk, 'build-tools');
    let versions: string[];
    try {
      versions = (await readdir(dir)).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      versions = [];
    }
    for (const version of versions) {
      const candidate = join(
        dir,
        version,
        process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
      );
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next installed build-tools version.
      }
    }
  }
  return 'apksigner';
}

async function command(
  program: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number;
    stdout: Buffer;
    stderr: string;
  }>();
  const executable = await findWindowsCommand(program);
  const batch =
    process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable);
  if (batch && [executable, ...args].some((value) => /["%\r\n]/.test(value))) {
    throw new Error(
      'Batch command arguments cannot contain quotes, percent signs, or newlines',
    );
  }
  const batchLine = batch
    ? `"${[executable, ...args].map((value) => `"${value}"`).join(' ')}"`
    : '';
  const child = spawn(
    batch ? (process.env.ComSpec ?? 'cmd.exe') : executable,
    batch ? ['/d', '/v:off', '/s', '/c', batchLine] : args,
    {
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: batch,
      signal,
    },
  );
  const out: Buffer[] = [],
    err: Buffer[] = [];
  child.stdout.on('data', (data: Buffer) => out.push(data));
  child.stderr.on('data', (data: Buffer) => err.push(data));
  child.on('error', reject);
  child.on('close', (code) =>
    resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString('utf8'),
    }),
  );
  return promise;
}
async function adb(
  auth: LeaseAuthorizer,
  args: DeviceArgs,
  ...argv: string[]
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return auth.withLease(args.leaseId, args.serial, (serial, signal) =>
    command(args.adb ?? 'adb', ['-s', serial, ...argv], signal),
  );
}
function text(result: { stdout: Buffer }): string {
  return result.stdout.toString('utf8');
}
function checked(
  result: { code: number; stdout: Buffer; stderr: string },
  action: string,
): string {
  const output = text(result);
  if (result.code !== 0)
    throw new Error(`${action} failed: ${result.stderr || output}`);
  return output;
}
async function shell(
  auth: LeaseAuthorizer,
  args: DeviceArgs,
  ...argv: string[]
): Promise<string> {
  return checked(await adb(auth, args, 'shell', ...argv), argv.join(' '));
}
function validPackage(value: string): void {
  if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value))
    throw new Error('Invalid Android package name');
}
function unsupported(reason: string) {
  return { status: 'unsupported' as const, reason };
}

export async function resetApp(
  auth: LeaseAuthorizer,
  args: DeviceArgs & { packageName: string },
) {
  validPackage(args.packageName);
  checked(
    await adb(auth, args, 'shell', 'pm', 'clear', args.packageName),
    'Clear app data',
  );
  const permissions = await shell(
    auth,
    args,
    'dumpsys',
    'package',
    args.packageName,
  );
  for (const match of permissions.matchAll(
    /^\s*(android\.permission\.[\w.]+): granted=true/gm,
  )) {
    await adb(auth, args, 'shell', 'pm', 'revoke', args.packageName, match[1]!);
  }
  const listeners = (
    await shell(
      auth,
      args,
      'settings',
      'get',
      'secure',
      'enabled_notification_listeners',
    )
  ).trim();
  if (listeners && listeners !== 'null') {
    const kept = listeners
      .split(':')
      .filter((component) => !component.startsWith(`${args.packageName}/`));
    await shell(
      auth,
      args,
      'settings',
      'put',
      'secure',
      'enabled_notification_listeners',
      kept.join(':'),
    );
  }
  for (const cmd of [
    ['settings', 'put', 'system', 'font_scale', '1.0'],
    ['wm', 'size', 'reset'],
    ['wm', 'density', 'reset'],
    ['settings', 'put', 'global', 'auto_time', '1'],
    ['settings', 'put', 'system', 'accelerometer_rotation', '1'],
    ['cmd', 'uimode', 'night', 'no'],
    ['settings', 'put', 'global', 'low_power', '0'],
  ])
    await shell(auth, args, ...cmd);
  const locale = await adb(
    auth,
    args,
    'shell',
    'cmd',
    'locale',
    'set-app-locales',
    args.packageName,
  );
  if (locale.code !== 0)
    return unsupported('Resetting app locale is unavailable on this device');
  return { status: 'pass' as const };
}

export async function setDeviceState(
  auth: LeaseAuthorizer,
  args: DeviceArgs & { state: DeviceState },
) {
  const state = args.state;
  if (
    state.fontScale !== undefined &&
    (!Number.isFinite(state.fontScale) || state.fontScale <= 0)
  )
    throw new Error('Invalid font scale');
  if (state.displaySize !== undefined && !/^\d+x\d+$/.test(state.displaySize))
    throw new Error('Invalid display size');
  if (
    state.density !== undefined &&
    (!Number.isInteger(state.density) || state.density <= 0)
  )
    throw new Error('Invalid density');
  if (state.rotation !== undefined && ![0, 1, 2, 3].includes(state.rotation))
    throw new Error('Invalid rotation');
  if (state.clock !== undefined && !/^[0-9.]+$/.test(state.clock))
    throw new Error('Invalid clock value');
  const operations: string[][] = [];
  if (state.locale !== undefined)
    return unsupported(
      'Changing the system locale requires a device-specific privileged API',
    );
  if (state.fontScale !== undefined)
    operations.push([
      'settings',
      'put',
      'system',
      'font_scale',
      String(state.fontScale),
    ]);
  if (state.displaySize !== undefined)
    operations.push(['wm', 'size', state.displaySize]);
  if (state.density !== undefined)
    operations.push(['wm', 'density', String(state.density)]);
  if (state.darkMode !== undefined)
    operations.push(['cmd', 'uimode', 'night', state.darkMode ? 'yes' : 'no']);
  if (state.batterySaver !== undefined)
    operations.push([
      'settings',
      'put',
      'global',
      'low_power',
      state.batterySaver ? '1' : '0',
    ]);
  if (state.rotation !== undefined)
    operations.push(
      ['settings', 'put', 'system', 'accelerometer_rotation', '0'],
      ['settings', 'put', 'system', 'user_rotation', String(state.rotation)],
    );
  if (state.clock !== undefined) {
    const id = await shell(auth, args, 'id', '-u');
    if (id.trim() !== '0')
      return unsupported('Setting the clock requires root adb');
    operations.push(
      ['settings', 'put', 'global', 'auto_time', '0'],
      ['date', state.clock],
    );
  }
  if (state.network !== undefined) {
    if (state.network.speed !== undefined)
      operations.push([
        'cmd',
        'connectivity',
        'set-airplane-mode',
        state.network.speed === 'offline' ? 'enabled' : 'disabled',
      ]);
    if (
      state.network.delay !== undefined ||
      (state.network.speed !== undefined &&
        !['online', 'offline'].includes(state.network.speed))
    )
      return unsupported(
        'Requested network shaping requires emulator console support',
      );
  }
  for (const operation of operations) {
    const result = await adb(auth, args, 'shell', ...operation);
    if (
      result.code !== 0 ||
      /(?:error|unknown command|permission denied)/i.test(
        text(result) + result.stderr,
      )
    )
      return unsupported(`Device does not support ${operation.join(' ')}`);
  }
  return { status: 'pass' as const };
}

export async function install(
  auth: LeaseAuthorizer,
  args: DeviceArgs & {
    apk: string;
    packageName: string;
    versionCode?: string | number;
    signer?: string;
    apksigner?: string;
    sdkRoot?: string;
  },
) {
  validPackage(args.packageName);
  let result = await adb(auth, args, 'install', '-r', args.apk);
  if (
    result.code !== 0 &&
    /INSTALL_FAILED_(?:UPDATE_INCOMPATIBLE|SHARED_USER_INCOMPATIBLE)/.test(
      text(result) + result.stderr,
    )
  ) {
    checked(
      await adb(auth, args, 'uninstall', args.packageName),
      'Uninstall conflicting package',
    );
    result = await adb(auth, args, 'install', args.apk);
  }
  checked(result, 'Install APK');
  const installed = await shell(
    auth,
    args,
    'dumpsys',
    'package',
    args.packageName,
  );
  const versionCode = /\bversionCode=(\d+)/.exec(installed)?.[1];
  if (
    !versionCode ||
    (args.versionCode !== undefined && versionCode !== String(args.versionCode))
  )
    throw new Error('Installed version code does not match');
  const apksigner = args.apksigner ?? (await findApksigner(args.sdkRoot));
  const apkSignature = await command(apksigner, [
    'verify',
    '--print-certs',
    args.apk,
  ]);
  const signer = /Signer #1 certificate SHA-256 digest:\s*([\da-f:]+)/i
    .exec(checked(apkSignature, 'Inspect APK signer'))?.[1]
    ?.replaceAll(':', '')
    .toLowerCase();
  if (
    !signer ||
    (args.signer && signer !== args.signer.replaceAll(':', '').toLowerCase())
  )
    throw new Error('APK signer does not match');
  const packagePath = /^package:(.+)$/m.exec(
    await shell(auth, args, 'pm', 'path', args.packageName),
  )?.[1];
  if (!packagePath) throw new Error('Installed APK path unavailable');
  const temp = join(tmpdir(), `emu-lab-${process.pid}-${Date.now()}.apk`);
  try {
    checked(
      await adb(auth, args, 'pull', packagePath, temp),
      'Pull installed APK',
    );
    const actual = checked(
      await command(apksigner, ['verify', '--print-certs', temp]),
      'Inspect installed signer',
    );
    const installedSigner =
      /Signer #1 certificate SHA-256 digest:\s*([\da-f:]+)/i
        .exec(actual)?.[1]
        ?.replaceAll(':', '')
        .toLowerCase();
    if (installedSigner !== signer)
      throw new Error('Installed signer does not match APK');
  } finally {
    await rm(temp, { force: true });
  }
  return { status: 'pass' as const, versionCode, signer };
}

async function prepare(auth: LeaseAuthorizer, args: RunnerArgs) {
  await mkdir(args.artifactDir, { recursive: true });
  const reset = await resetApp(auth, args);
  if (reset.status !== 'pass') return reset;
  return setDeviceState(auth, { ...args, state: args.state ?? {} });
}
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
export async function runInstrumentation(
  auth: LeaseAuthorizer,
  args: RunnerArgs & {
    runner: string;
    apk?: string;
    testApk?: string;
    filter?: string;
  },
) {
  if (args.apk) await install(auth, { ...args, apk: args.apk });
  if (args.testApk)
    checked(
      await adb(auth, args, 'install', '-r', args.testApk),
      'Install test APK',
    );
  const ready = await prepare(auth, args);
  if (ready.status !== 'pass') return ready;
  const cmd = ['shell', 'am', 'instrument', '-w', '-r'];
  if (args.filter) cmd.push('-e', 'class', args.filter);
  cmd.push(args.runner);
  const result = await adb(auth, args, ...cmd),
    output = text(result);
  const count = Number(
    /(?:OK \((\d+) tests?\)|Tests run:\s*(\d+)|INSTRUMENTATION_STATUS: numtests=(\d+))/i
      .exec(output)
      ?.slice(1)
      .find(Boolean) ?? 0,
  );
  const failed =
    result.code !== 0 ||
    count === 0 ||
    /FAILURES!!!|INSTRUMENTATION_FAILED|shortMsg=|Process crashed/i.test(
      output,
    );
  const report = join(args.artifactDir, 'instrumentation.xml');
  await writeFile(
    report,
    `<?xml version="1.0" encoding="UTF-8"?><testsuite name="instrumentation" tests="${count}" failures="${failed ? 1 : 0}"><system-out>${xml(output)}</system-out>${failed ? `<testcase name="instrumentation"><failure message="${count === 0 ? 'No tests completed' : 'Instrumentation failed'}">${xml(output)}</failure></testcase>` : ''}</testsuite>`,
  );
  const artifacts = [report];
  if (/crash|shortMsg=|INSTRUMENTATION_FAILED/i.test(output))
    artifacts.push(
      (
        await logcat(auth, {
          ...args,
          path: join(args.artifactDir, 'instrumentation-logcat.txt'),
        })
      ).path,
    );
  return {
    status: failed ? ('fail' as const) : ('pass' as const),
    count,
    output,
    artifacts,
  };
}

export async function screen(
  auth: LeaseAuthorizer,
  args: DeviceArgs & { artifactDir: string },
) {
  await mkdir(args.artifactDir, { recursive: true });
  let hierarchy = '';
  for (
    let attempt = 0;
    attempt < 3 && !hierarchy.includes('<hierarchy');
    attempt++
  ) {
    const result = await adb(
      auth,
      args,
      'shell',
      'uiautomator',
      'dump',
      '/sdcard/window.xml',
    );
    if (result.code === 0)
      hierarchy = text(
        await adb(auth, args, 'shell', 'cat', '/sdcard/window.xml'),
      );
  }
  if (!hierarchy.includes('<hierarchy'))
    hierarchy = await shell(auth, args, 'dumpsys', 'accessibility');
  const hierarchyPath = join(args.artifactDir, 'hierarchy.txt');
  await writeFile(hierarchyPath, hierarchy);
  const shot = await adb(auth, args, 'exec-out', 'screencap', '-p');
  checked(shot, 'Capture screenshot');
  const screenshotPath = join(args.artifactDir, 'screenshot.png');
  await writeFile(screenshotPath, shot.stdout);
  const windows = await shell(auth, args, 'dumpsys', 'window');
  const secure =
    /FLAG_SECURE/i.test(windows) ||
    [...windows.matchAll(/\bfl=([0-9a-f]+)/gi)].some(
      (match) => (parseInt(match[1]!, 16) & 0x2000) !== 0,
    );
  return {
    status: 'pass' as const,
    hierarchy,
    hierarchyPath,
    screenshotPath,
    secure,
    annotation: secure
      ? 'Secure window may cause a black screenshot'
      : undefined,
  };
}
export async function logcat(
  auth: LeaseAuthorizer,
  args: DeviceArgs & { path: string; pid?: number; lines?: number },
) {
  const argv = ['logcat', '-d'];
  if (args.pid !== undefined) argv.push('--pid', String(args.pid));
  if (args.lines !== undefined) argv.push('-t', String(args.lines));
  const output = checked(await adb(auth, args, ...argv), 'Collect logcat');
  await mkdir(dirname(args.path), { recursive: true });
  await writeFile(args.path, output);
  return { status: 'pass' as const, path: args.path, output };
}
export async function reverse(
  auth: LeaseAuthorizer,
  args: DeviceArgs & { devicePort: number; hostPort: number; remove?: boolean },
) {
  for (const port of [args.devicePort, args.hostPort])
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid port');
  const argv = args.remove
    ? ['reverse', '--remove', `tcp:${args.devicePort}`]
    : ['reverse', `tcp:${args.devicePort}`, `tcp:${args.hostPort}`];
  checked(await adb(auth, args, ...argv), 'Configure adb reverse');
  return { status: 'pass' as const, hostAddress: '10.0.2.2' };
}
export async function runMaestro(
  auth: LeaseAuthorizer,
  args: RunnerArgs & { flows: string[]; maestro?: string },
) {
  const ready = await prepare(auth, args);
  if (ready.status !== 'pass') return ready;
  const results: {
    flow: string;
    status: 'pass' | 'fail' | 'flaky';
    output: string;
    artifacts: string[];
  }[] = [];
  for (let index = 0; index < args.flows.length; index++) {
    const flow = args.flows[index]!,
      dir = join(args.artifactDir, `flow-${index + 1}`);
    await mkdir(dir, { recursive: true });
    const run = () =>
      auth.withLease(args.leaseId, args.serial, (serial, signal) =>
        command(
          args.maestro ?? 'maestro',
          ['--device', serial, 'test', '--debug-output', dir, flow],
          signal,
        ),
      );
    const first = await run();
    let status: 'pass' | 'fail' | 'flaky' = first.code === 0 ? 'pass' : 'fail';
    const artifacts: string[] = [];
    if (first.code !== 0) {
      const capture = await screen(auth, { ...args, artifactDir: dir });
      artifacts.push(capture.hierarchyPath, capture.screenshotPath);
      const reset = await prepare(auth, args);
      if (reset.status !== 'pass') return reset;
      if ((await run()).code === 0) status = 'flaky';
    }
    const output = text(first) + first.stderr;
    const outputPath = join(dir, 'output.txt');
    await writeFile(outputPath, output);
    artifacts.push(outputPath);
    results.push({ flow, status, output, artifacts });
  }
  return {
    status: results.some((r) => r.status === 'fail')
      ? ('fail' as const)
      : results.some((r) => r.status === 'flaky')
        ? ('flaky' as const)
        : ('pass' as const),
    results,
  };
}
export async function smokeRelease(
  auth: LeaseAuthorizer,
  args: RunnerArgs & { activity?: string },
) {
  const ready = await prepare(auth, args);
  if (ready.status !== 'pass') return ready;
  const since = new Date().toISOString().replace('T', ' ').replace('Z', '');
  if (args.activity)
    await shell(
      auth,
      args,
      'am',
      'start',
      '-W',
      '-n',
      `${args.packageName}/${args.activity}`,
    );
  else await shell(auth, args, 'monkey', '-p', args.packageName, '1');
  const windows = await shell(auth, args, 'dumpsys', 'window');
  const uid = /\buserId=(\d+)/.exec(
    await shell(auth, args, 'dumpsys', 'package', args.packageName),
  )?.[1];
  if (!uid) throw new Error('App UID unavailable');
  const logs = checked(
    await adb(auth, args, 'logcat', '-d', '-T', since, '--uid', uid),
    'Collect app logcat',
  );
  const path = join(args.artifactDir, 'smoke-logcat.txt');
  await writeFile(path, logs);
  const failures = logs
    .split(/\r?\n/)
    .filter((line) =>
      /(?:NoClassDefFoundError|ClassNotFoundException|NoSuchMethodError|Unable to instantiate (?:activity|service|receiver|application)|ActivityNotFoundException)/i.test(
        line,
      ),
    );
  return {
    status: failures.length ? ('fail' as const) : ('pass' as const),
    secure: /FLAG_SECURE/i.test(windows),
    failures,
    artifacts: [path],
  };
}
