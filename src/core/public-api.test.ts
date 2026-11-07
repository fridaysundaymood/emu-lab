import { describe, expect, it, vi } from 'vitest';

describe('public API', () => {
  it('imports without starting a stdio transport', async () => {
    vi.resetModules();
    const before = process.stdin.listenerCount('data');
    // The import must occur after the listener count is captured.
    const api = await import('./index.js');
    expect(process.stdin.listenerCount('data')).toBe(before);
    expect(api.configSection).toBe('emuLab');
    expect(api.configSectionSchema).toBe(api.configSchema);
    expect(api.supportedSchemaMajors).toEqual([1]);
    expect(api.toolDefinitions().map((tool) => tool.name)).toContain(
      'emu_lab_doctor',
    );
    expect(typeof api.doctor).toBe('function');
    const dispatcher = vi.fn().mockResolvedValue({ status: 'pass' });
    const tool = api
      .toolDefinitions({
        projectRoot: 'root',
        configPath: 'kit.yaml',
        dispatcher,
      })
      .find((entry) => entry.name === 'emu_lab_doctor');
    expect(tool).toBeDefined();
    await tool?.handler({ projectRoot: 'override' });
    expect(dispatcher).toHaveBeenCalledWith('doctor', {
      projectRoot: 'override',
      configPath: 'kit.yaml',
    });
  }, 30000);
});
