import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  adapterError,
  type Dispatcher,
  invoke,
  operations,
} from '../cli/operations.js';

const fields: Record<string, Record<string, string>> = {
  'lease-device': { profile: 'string', ttlMs: 'number', heartbeatMs: 'number' },
  'lease-group': { profiles: 'array', ttlMs: 'number', heartbeatMs: 'number' },
  build: {
    variant: 'string',
    testVariant: 'string',
    commit: 'string',
    module: 'string',
    release: 'boolean',
  },
  install: {
    apk: 'string',
    packageName: 'string',
    versionCode: 'string-or-number',
    signer: 'string',
  },
  'reset-app': { packageName: 'string' },
  'set-device-state': { state: 'object' },
  'run-instrumentation': {
    packageName: 'string',
    state: 'object',
    runner: 'string',
    apk: 'string',
    testApk: 'string',
    timeoutMs: 'number',
    filter: 'string',
  },
  'run-maestro': { packageName: 'string', state: 'object', flows: 'array' },
  'smoke-release': {
    packageName: 'string',
    state: 'object',
    activity: 'string',
  },
  'pull-artifact': { sourceRunId: 'string', artifact: 'string' },
  reverse: { devicePort: 'number', hostPort: 'number', remove: 'boolean' },
  snapshot: { action: 'string', name: 'string' },
  'classify-failure': {
    log: 'string',
    hierarchy: 'string',
    appPackage: 'string',
    expectedScreen: 'string',
    selectorMissing: 'boolean',
    resetExpected: 'boolean',
    isolatedRerunPassed: 'boolean',
    artifacts: 'array',
  },
};

export function toolDefinitions(
  options: {
    projectRoot?: string;
    configPath?: string;
    dispatcher?: Dispatcher;
  } = {},
) {
  return operations.map((operation) => ({
    name: `emu_lab_${operation === 'lab-status' ? 'status' : operation.replaceAll('-', '_')}`,
    description: `Run emu-lab ${operation}. Arguments match the corresponding CLI options in camelCase.`,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries({
          leaseId: 'string',
          serial: 'string',
          ...fields[operation],
        }).map(([name, type]) => [
          name,
          type === 'array'
            ? { type, items: { type: 'string' } }
            : type === 'object'
              ? {
                  type,
                  additionalProperties: false,
                  properties: {
                    locale: { type: 'string' },
                    fontScale: { type: 'number' },
                    displaySize: { type: 'string' },
                    density: { type: 'number' },
                    clock: { type: 'string' },
                    darkMode: { type: 'boolean' },
                    batterySaver: { type: 'boolean' },
                    rotation: { type: 'number' },
                    network: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        speed: { type: 'string' },
                        delay: { type: 'string' },
                      },
                    },
                  },
                }
              : type === 'string-or-number'
                ? { anyOf: [{ type: 'string' }, { type: 'number' }] }
                : { type },
        ]),
      ),
      additionalProperties: false,
    },
    handler: async (input: Record<string, unknown>) => {
      try {
        const allowed = new Set([
          'leaseId',
          'serial',
          ...Object.keys(fields[operation] ?? {}),
        ]);
        if (Object.keys(input).some((key) => !allowed.has(key)))
          throw new Error('Unknown tool input property');
        const root = await realpath(options.projectRoot ?? process.cwd());
        const checked = { ...input };
        for (const key of ['apk', 'testApk', 'flows']) {
          const value = checked[key];
          if (value === undefined) continue;
          const paths = Array.isArray(value) ? value : [value];
          const resolved = await Promise.all(
            paths.map(async (path) => {
              if (typeof path !== 'string')
                throw new Error('Invalid file path');
              const file = await realpath(resolve(root, path));
              const part = relative(root, file);
              if (
                part === '..' ||
                part.startsWith(`..${sep}`) ||
                isAbsolute(part)
              )
                throw new Error('File path must be inside the project root');
              return file;
            }),
          );
          checked[key] = Array.isArray(value) ? resolved : resolved[0];
        }
        return await invoke(
          operation,
          {
            ...checked,
            projectRoot: root,
            ...(options.configPath === undefined
              ? {}
              : { configPath: options.configPath }),
          },
          options.dispatcher,
        );
      } catch (error) {
        return adapterError(operation, error);
      }
    },
  }));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  run?: Dispatcher,
) {
  const definition = toolDefinitions({ dispatcher: run }).find(
    (tool) => tool.name === name,
  );
  const result = definition
    ? await definition.handler(args)
    : await invoke(`unknown-${name}`, args, run);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: result.status !== 'pass',
  };
}

export function createServer(run?: Dispatcher): Server {
  const server = new Server(
    { name: 'emu-lab', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions().map(({ handler: _handler, ...tool }) => tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, run),
  );
  return server;
}
