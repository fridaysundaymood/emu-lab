import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '@android-kit/schema';
import type { DeviceProfile } from './scheduler.js';

export const configSchema = {
  properties: {
    budget: { type: 'integer', minimum: 1 },
    denySerials: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    },
    sdkRoot: { type: 'string', minLength: 1 },
    allowInstall: { type: 'boolean' },
    databasePath: { type: 'string', minLength: 1 },
    maestroPath: { type: 'string', minLength: 1 },
    adbPath: { type: 'string', minLength: 1 },
    bootTimeoutMs: { type: 'integer', minimum: 1 },
    headless: { type: 'boolean' },
    maxCpuLoad: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    profiles: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: [
          'image',
          'api',
          'ramMb',
          'cores',
          'gpu',
          'root',
          'locale',
          'density',
        ],
        properties: {
          image: {
            type: 'string',
            pattern:
              '^system-images;android-[0-9]+;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+$',
          },
          api: { type: 'integer', minimum: 1 },
          ramMb: { type: 'integer', minimum: 1 },
          cores: { type: 'integer', minimum: 1 },
          gpu: { enum: ['auto', 'host', 'swiftshader_indirect'] },
          root: { type: 'boolean' },
          locale: { type: 'string', minLength: 2 },
          density: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

export interface LabConfig {
  budget?: number;
  denySerials?: string[];
  sdkRoot?: string;
  allowInstall?: boolean;
  databasePath?: string;
  maestroPath?: string;
  adbPath?: string;
  bootTimeoutMs?: number;
  headless?: boolean;
  maxCpuLoad?: number;
  profiles?: Record<string, DeviceProfile>;
}

export async function readConfig(
  root: string,
  configPath?: string,
): Promise<LabConfig> {
  const path = configPath
    ? resolve(root, configPath)
    : join(root, 'android-kit.yaml');
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return (
    (await loadConfig<LabConfig>(path, {
      name: 'emuLab',
      schema: configSchema,
    })) ?? {}
  );
}
