import { createResult, newRunId, type Result } from '@android-kit/schema';
import { dispatch } from '../core/index.js';

export const operations = [
  'doctor',
  'lab-status',
  'lease-device',
  'heartbeat',
  'release-device',
  'lease-group',
  'build',
  'install',
  'reset-app',
  'set-device-state',
  'run-instrumentation',
  'run-maestro',
  'smoke-release',
  'screen',
  'logcat',
  'pull-artifact',
  'reverse',
  'snapshot',
  'classify-failure',
] as const;

export type Dispatcher = (
  operation: string,
  args: Record<string, unknown>,
) => Promise<Result>;

export function adapterError(
  operation: string,
  error: unknown,
  startedAt = new Date(),
): Result {
  return createResult({
    tool: 'emu-lab',
    operation: operation.replaceAll('-', '_') || 'unknown',
    run_id: newRunId(),
    status: 'error',
    classification: 'config',
    summary: error instanceof Error ? error.message : String(error),
    evidence: [],
    artifacts: [],
    startedAt,
  });
}

export async function invoke(
  operation: string,
  args: Record<string, unknown>,
  run: Dispatcher = dispatch,
): Promise<Result> {
  const startedAt = new Date();
  try {
    if (!operations.some((name) => name === operation))
      throw new Error(`Unknown operation: ${operation}`);
    return await run(operation, args);
  } catch (error) {
    return adapterError(operation, error, startedAt);
  }
}
