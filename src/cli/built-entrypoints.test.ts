import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('starts built CLI and MCP entrypoints', async () => {
  const cli = 'dist/cli/index.js';
  expect(
    execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }),
  ).toContain('Commands:');
  if (process.platform !== 'win32') {
    const dir = await mkdtemp(join(tmpdir(), 'emu-lab-bin-'));
    try {
      const link = join(dir, 'emu-lab');
      await symlink(resolve(cli), link);
      expect(
        execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' }),
      ).toContain('Commands:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(doctor.error).toBeUndefined();
  expect(JSON.parse(doctor.stdout).operation).toBe('emu_lab_doctor');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp/bin.js'],
  });
  const client = new Client({ name: 'entrypoint-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === 'emu_lab_doctor',
      ),
    ).toBe(true);
  } finally {
    await client.close();
  }
}, 60000);
