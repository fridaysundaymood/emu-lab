#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { exitCodeFor, type Result } from '@android-kit/schema';
import {
  adapterError,
  type Dispatcher,
  invoke,
  operations,
} from './operations.js';

function parseValue(value: string): unknown {
  if (
    /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\[|\{)/.test(
      value,
    )
  ) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      /* Treat ordinary strings as strings. */
    }
  }
  return value;
}

export function parseArgs(argv: string[]): {
  operation: string;
  args: Record<string, unknown>;
} {
  const operation = argv[0] ?? '';
  const args: Record<string, unknown> = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--json') continue;
    if (!token.startsWith('--') || token === '--')
      throw new Error(`Expected an option, got ${token}`);
    const equals = token.indexOf('=');
    const rawName = token.slice(2, equals < 0 ? undefined : equals);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(rawName))
      throw new Error(`Invalid option: ${token}`);
    const name = rawName.replace(/-([a-z0-9])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    let raw = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (
      raw === undefined &&
      i + 1 < argv.length &&
      !argv[i + 1]!.startsWith('--')
    )
      raw = argv[++i];
    const value = raw === undefined ? true : parseValue(raw);
    if (Object.hasOwn(args, name))
      args[name] = Array.isArray(args[name])
        ? [...(args[name] as unknown[]), value]
        : [args[name], value];
    else args[name] = value;
  }
  return { operation, args };
}

export async function runCli(
  argv: string[],
  run?: Dispatcher,
): Promise<Result> {
  try {
    const { operation, args } = parseArgs(argv);
    return await invoke(operation, args, run);
  } catch (error) {
    return adapterError(argv[0] ?? '', error);
  }
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(
      `Usage: emu-lab <command> [--option value] [--json]\nCommands: ${operations.join(', ')}\nOptions use kebab-case; arrays and objects accept JSON.\n`,
    );
    return;
  }
  const result = await runCli(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCodeFor(result.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
