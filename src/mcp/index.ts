import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type Dispatcher, invoke, operations } from '../cli/operations.js';

const fields: Record<string, Record<string, string>> = {
  'lease-device': { profile: 'string', ttlMs: 'number', heartbeatMs: 'number' },
  'lease-group': { profiles: 'array', ttlMs: 'number', heartbeatMs: 'number' },
  build: {
    variant: 'string',
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
          projectRoot: 'string',
          leaseId: 'string',
          serial: 'string',
          ...fields[operation],
        }).map(([name, type]) => [
          name,
          type === 'array'
            ? { type, items: { type: 'string' } }
            : type === 'object'
              ? { type, additionalProperties: true }
              : type === 'string-or-number'
                ? { anyOf: [{ type: 'string' }, { type: 'number' }] }
                : { type },
        ]),
      ),
      additionalProperties: true,
    },
    handler: (input: Record<string, unknown>) =>
      invoke(
        operation,
        {
          ...(options.projectRoot === undefined
            ? {}
            : { projectRoot: options.projectRoot }),
          ...(options.configPath === undefined
            ? {}
            : { configPath: options.configPath }),
          ...input,
        },
        options.dispatcher,
      ),
  }));
}

export const tools = toolDefinitions().map(
  ({ handler: _handler, ...tool }) => tool,
);

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
    { name: 'emu-lab', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, run),
  );
  return server;
}
