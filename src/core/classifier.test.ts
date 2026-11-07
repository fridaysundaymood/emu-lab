import { describe, expect, it } from 'vitest';
import { classifyFailure, validateRules } from './classifier.js';

describe('failure classifier golden cases', () => {
  const artifacts = ['.android-kit/runs/r/emu-lab/log.txt'];
  const cases = [
    {
      input: { log: 'error: device offline', artifacts },
      rule: 'device-offline',
      classification: 'environment',
    },
    {
      input: { log: 'ANR in com.android.systemui', artifacts },
      rule: 'system-ui-anr',
      classification: 'environment',
    },
    {
      input: { log: 'boot timed out', artifacts },
      rule: 'incomplete-boot',
      classification: 'environment',
    },
    {
      input: { log: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE', artifacts },
      rule: 'install-failure',
      classification: 'environment',
    },
    {
      input: { log: 'emulator process died', artifacts },
      rule: 'emulator-death',
      classification: 'environment',
    },
    {
      input: { log: 'excessive host load', artifacts },
      rule: 'host-load',
      classification: 'environment',
    },
    {
      input: {
        log: 'ANR in com.example.app',
        appPackage: 'com.example.app',
        artifacts,
      },
      rule: 'app-anr',
      classification: 'app',
    },
    {
      input: {
        log: 'FATAL EXCEPTION: main\n  at com.example.app.Main.run(Main.kt:1)',
        appPackage: 'com.example.app',
        artifacts,
      },
      rule: 'app-crash',
      classification: 'app',
    },
    {
      input: {
        log: 'AssertionError: stale data',
        resetExpected: true,
        artifacts,
      },
      rule: 'reset-state',
      classification: 'test',
    },
    {
      input: {
        log: 'selector not found',
        hierarchy: '<node text="Home"/>',
        expectedScreen: 'Home',
        selectorMissing: true,
        artifacts,
      },
      rule: 'changed-copy',
      classification: 'test',
    },
    {
      input: {
        log: 'AssertionError: wrong total',
        hierarchy: '<node text="Home"/>',
        expectedScreen: 'Home',
        artifacts,
      },
      rule: 'app-assertion',
      classification: 'app',
    },
  ] as const;
  for (const item of cases)
    it(item.rule, () => {
      const verdict = classifyFailure(item.input);
      expect(verdict).toMatchObject({
        ruleId: item.rule,
        classification: item.classification,
        status: 'fail',
        ruleVersion: '1.0.0',
        artifacts,
      });
      expect(verdict.evidence.length).toBeGreaterThan(0);
    });
  it('gives isolated reruns precedence and records flaky', () => {
    expect(
      classifyFailure({
        log: 'device offline',
        isolatedRerunPassed: true,
        artifacts,
      }),
    ).toMatchObject({
      status: 'flaky',
      classification: 'test',
      ruleId: 'isolated-rerun-passed',
    });
  });
  it('does not guess from partial or ambiguous evidence', () => {
    expect(classifyFailure({ log: '', artifacts })).toEqual({
      status: 'fail',
      ruleVersion: '1.0.0',
      evidence: [],
      artifacts,
    });
    expect(
      classifyFailure({ log: 'FATAL EXCEPTION: main', artifacts }),
    ).not.toHaveProperty('classification');
    expect(
      classifyFailure({
        log: 'selector not found',
        selectorMissing: true,
        hierarchy: '<node text="Other"/>',
        expectedScreen: 'Home',
        artifacts,
      }),
    ).not.toHaveProperty('classification');
  });
  it('escapes dynamic matchers', () => {
    expect(
      classifyFailure({
        log: 'ANR in comXexampleXapp',
        appPackage: 'com.example.app',
        artifacts,
      }),
    ).not.toHaveProperty('classification');
  });
  it('uses explicit priorities independent of file order and preserves rule version', () => {
    const rules = validateRules({
      version: '2',
      rules: [
        {
          id: 'low',
          precedence: 1,
          classification: 'app',
          all: [{ source: 'log', pattern: 'failure' }],
        },
        {
          id: 'high',
          precedence: 2,
          classification: 'test',
          all: [{ source: 'log', pattern: 'failure' }],
        },
      ],
    });
    expect(classifyFailure({ log: 'failure', artifacts }, rules)).toMatchObject(
      { ruleVersion: '2', ruleId: 'high', classification: 'test' },
    );
    expect(() =>
      validateRules({
        version: '2',
        rules: [rules.rules[0], { ...rules.rules[1], precedence: 1 }],
      }),
    ).toThrow();
  });
});
