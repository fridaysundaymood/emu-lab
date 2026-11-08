import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from '@budaknyenyel/kit-schema';
import { exitCodeFor } from '@budaknyenyel/kit-schema';
import { describe, expect, it } from 'vitest';
import { callTool, toolDefinitions } from '../mcp/index.js';
import { runCli } from './index.js';
import { type Dispatcher, operations } from './operations.js';

const result: Result = {
  schema_version: '1',
  tool: 'emu-lab',
  operation: 'reverse',
  run_id: 'test',
  status: 'pass',
  summary: 'ok',
  evidence: [],
  artifacts: [],
  started_at: '2026-01-01T00:00:00.000Z',
  duration_ms: 0,
};

describe('CLI and MCP adapters', () => {
  it('exposes the same operations', () => {
    expect(toolDefinitions().map((tool) => tool.name)).toEqual(
      operations.map(
        (operation) =>
          `emu_lab_${operation === 'lab-status' ? 'status' : operation.replaceAll('-', '_')}`,
      ),
    );
  });

  it('dispatches equivalent arguments and returns the same envelope', async () => {
    const calls: unknown[] = [];
    const dispatch: Dispatcher = async (operation, args) => {
      calls.push({ operation, args });
      return result;
    };
    const args = {
      leaseId: 'lease',
      devicePort: 8080,
      hostPort: 3000,
      remove: true,
    };
    const cli = await runCli(
      [
        'reverse',
        '--lease-id',
        'lease',
        '--device-port',
        '8080',
        '--host-port=3000',
        '--remove',
        '--json',
      ],
      dispatch,
    );
    const mcp = await callTool('emu_lab_reverse', args, dispatch);
    expect(calls).toEqual([
      { operation: 'reverse', args },
      {
        operation: 'reverse',
        args: { ...args, projectRoot: realpathSync(process.cwd()) },
      },
    ]);
    expect(JSON.parse(mcp.content[0]!.text)).toEqual(cli);
  });

  it('rejects caller overrides of launch configuration and executable paths', async () => {
    const handler = toolDefinitions({
      projectRoot: process.cwd(),
      configPath: 'fixed.yaml',
    }).find((tool) => tool.name === 'emu_lab_install')!;
    expect(handler.inputSchema.additionalProperties).toBe(false);
    for (const input of [
      { projectRoot: '..' },
      { configPath: 'other.yaml' },
      { apksigner: 'evil' },
      { sdkRoot: 'evil' },
    ]) {
      expect((await handler.handler(input)).status).toBe('error');
    }
  });

  it('rejects paths escaping through symlinks', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'emu-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'emu-outside-'));
    try {
      await writeFile(join(outside, 'app.apk'), '');
      await symlink(outside, join(root, 'link'));
      const handler = toolDefinitions({ projectRoot: root }).find(
        (tool) => tool.name === 'emu_lab_install',
      )!;
      expect((await handler.handler({ apk: 'link/app.apk' })).status).toBe(
        'error',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('maps all result statuses to the documented exit codes', () => {
    expect(
      ['pass', 'fail', 'flaky', 'blocked', 'unsupported', 'error'].map(
        (status) => exitCodeFor(status as Result['status']),
      ),
    ).toEqual([0, 1, 1, 2, 2, 2]);
  });

  it('returns an error envelope for malformed options', async () => {
    expect((await runCli(['reverse', 'unexpected'])).status).toBe('error');
  });
});
