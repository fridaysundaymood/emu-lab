import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  checkSchemaMajor,
  createResult,
  newRunId,
  type Result,
  runArtifactDir,
  type Status,
  writeArtifactIndex,
} from '@android-kit/schema';
import { pullArtifact } from './artifacts.js';
import { build } from './build.js';
import { classifyFailure } from './classifier.js';
import { readConfig } from './config.js';
import { doctor } from './doctor.js';
import * as runners from './runners.js';
import { HostLoadError, Scheduler } from './scheduler.js';

export { pullArtifact } from './artifacts.js';
export { build } from './build.js';
export { classifyFailure } from './classifier.js';
export { configSchema } from './config.js';
export * from './runners.js';
export { HostLoadError, Scheduler } from './scheduler.js';

export async function dispatch(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const startedAt = new Date();
  const runId = newRunId();
  const root = resolve(String(args.projectRoot ?? process.cwd()));
  let status: Status = 'pass';
  let summary = `${operation} completed`;
  let evidence: unknown[] = [];
  let artifacts: string[] = [];
  let classification: 'app' | 'test' | 'environment' | 'config' | undefined;
  let scheduler: Scheduler | undefined;
  try {
    checkSchemaMajor(1);
    const config = await readConfig(root);
    const artifactDir = runArtifactDir(root, runId, 'emu-lab');
    await mkdir(artifactDir, { recursive: true });
    const schedulerOptions = {
      ...config,
      databasePath:
        config.databasePath ?? join(root, '.android-kit', 'emu-lab.sqlite'),
    };
    const getScheduler = () => (scheduler ??= new Scheduler(schedulerOptions));
    let result: unknown;
    const input = {
      ...args,
      adb: config.adbPath,
      maestro: config.maestroPath,
      artifactDir,
    };
    switch (operation) {
      case 'doctor':
        result = await doctor(config);
        break;
      case 'lab-status':
        result = await getScheduler().status();
        break;
      case 'lease-device':
        result = await getScheduler().lease(
          args as Parameters<Scheduler['lease']>[0],
        );
        break;
      case 'lease-group':
        result = await getScheduler().leaseGroup(
          args as unknown as Parameters<Scheduler['leaseGroup']>[0],
        );
        break;
      case 'heartbeat':
        result = await getScheduler().heartbeat(String(args.leaseId ?? ''));
        break;
      case 'release-device':
        await getScheduler().release(String(args.leaseId ?? ''));
        result = {};
        break;
      case 'build':
        result = await build({
          ...args,
          projectRoot: root,
          runId,
        } as unknown as Parameters<typeof build>[0]);
        break;
      case 'classify-failure':
        result = classifyFailure(
          args as unknown as Parameters<typeof classifyFailure>[0],
        );
        break;
      case 'install':
        result = await runners.install(
          getScheduler(),
          input as unknown as Parameters<typeof runners.install>[1],
        );
        break;
      case 'reset-app':
        result = await runners.resetApp(
          getScheduler(),
          input as unknown as Parameters<typeof runners.resetApp>[1],
        );
        break;
      case 'set-device-state':
        result = await runners.setDeviceState(
          getScheduler(),
          input as unknown as Parameters<typeof runners.setDeviceState>[1],
        );
        break;
      case 'run-instrumentation':
        result = await runners.runInstrumentation(
          getScheduler(),
          input as unknown as Parameters<typeof runners.runInstrumentation>[1],
        );
        break;
      case 'run-maestro':
        result = await runners.runMaestro(
          getScheduler(),
          input as unknown as Parameters<typeof runners.runMaestro>[1],
        );
        break;
      case 'smoke-release':
        result = await runners.smokeRelease(
          getScheduler(),
          input as unknown as Parameters<typeof runners.smokeRelease>[1],
        );
        break;
      case 'screen':
        result = await runners.screen(
          getScheduler(),
          input as unknown as Parameters<typeof runners.screen>[1],
        );
        break;
      case 'logcat':
        result = await runners.logcat(getScheduler(), {
          ...input,
          path: join(artifactDir, 'logcat.txt'),
        } as unknown as Parameters<typeof runners.logcat>[1]);
        break;
      case 'pull-artifact':
        result = await pullArtifact({
          projectRoot: root,
          sourceRunId: String(args.sourceRunId ?? ''),
          artifact: String(args.artifact ?? ''),
          artifactDir,
        });
        break;
      case 'reverse':
        result = await runners.reverse(
          getScheduler(),
          input as unknown as Parameters<typeof runners.reverse>[1],
        );
        break;
      case 'snapshot':
        result = await getScheduler().snapshot(
          String(args.leaseId ?? ''),
          typeof args.serial === 'string' ? args.serial : undefined,
          String(args.action ?? '') as 'list' | 'save' | 'load' | 'delete',
          typeof args.name === 'string' ? args.name : undefined,
        );
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
    evidence = [result];
    if (result && typeof result === 'object') {
      const value = result as {
        status?: Status;
        classification?: typeof classification;
        artifacts?: string[];
        path?: string;
        hierarchyPath?: string;
        screenshotPath?: string;
        results?: { artifacts?: string[] }[];
      };
      status = value.status ?? 'pass';
      classification = value.classification;
      const paths = [
        ...(value.artifacts ?? []),
        ...(value.results?.flatMap((item) => item.artifacts ?? []) ?? []),
        ...[value.path, value.hierarchyPath, value.screenshotPath].filter(
          (item): item is string => !!item,
        ),
      ];
      artifacts = paths.map((path) =>
        (isAbsolute(path) ? relative(root, path) : path).replaceAll('\\', '/'),
      );
      if (artifacts.length)
        await writeArtifactIndex(root, runId, 'emu-lab', artifacts);
    }
    summary = `${operation} ${status}`;
  } catch (error) {
    status = error instanceof HostLoadError ? 'blocked' : 'error';
    summary = error instanceof Error ? error.message : String(error);
    if (error instanceof HostLoadError) {
      classification = 'environment';
      evidence = [{ cpuLoad: error.cpuLoad, maxCpuLoad: error.maxCpuLoad }];
    }
    console.error(
      JSON.stringify({
        level: 'error',
        run_id: runId,
        operation,
        message: summary,
      }),
    );
  } finally {
    scheduler?.close();
  }
  return createResult({
    startedAt,
    tool: 'emu-lab',
    operation: `emu_lab_${operation.replaceAll('-', '_')}`,
    run_id: runId,
    status,
    summary,
    evidence,
    artifacts,
    ...(classification ? { classification } : {}),
  });
}
