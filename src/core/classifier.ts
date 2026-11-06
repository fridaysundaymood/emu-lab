import ruleData from './classifier-rules.json' with { type: 'json' };

export type Classification = 'app' | 'test' | 'environment' | 'config';
type Source = 'log' | 'hierarchy' | 'fact';
export interface Matcher {
  source: Source;
  pattern: string;
}
export interface Rule {
  id: string;
  precedence: number;
  classification: Classification;
  status?: 'fail' | 'flaky';
  all: Matcher[];
}
export interface RuleSet {
  version: string;
  rules: Rule[];
}
export interface ClassifierInput {
  log: string;
  hierarchy?: string;
  artifacts: string[];
  appPackage?: string;
  expectedScreen?: string;
  selectorMissing?: boolean;
  resetExpected?: boolean;
  isolatedRerunPassed?: boolean;
}
export interface ClassificationVerdict {
  status: 'fail' | 'flaky';
  classification?: Classification;
  ruleId?: string;
  ruleVersion: string;
  evidence: string[];
  artifacts: string[];
}

export function validateRules(value: unknown): RuleSet {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid classifier rules');
  const set = value as RuleSet;
  if (
    typeof set.version !== 'string' ||
    !set.version ||
    !Array.isArray(set.rules)
  )
    throw new Error('Invalid classifier ruleset');
  const ids = new Set<string>();
  const priorities = new Set<number>();
  for (const rule of set.rules) {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      !rule.id ||
      ids.has(rule.id) ||
      !Number.isSafeInteger(rule.precedence) ||
      priorities.has(rule.precedence) ||
      !['app', 'test', 'environment', 'config'].includes(rule.classification) ||
      (rule.status !== undefined && !['fail', 'flaky'].includes(rule.status)) ||
      !Array.isArray(rule.all) ||
      rule.all.length === 0
    )
      throw new Error('Invalid or ambiguous classifier rule');
    ids.add(rule.id);
    priorities.add(rule.precedence);
    for (const matcher of rule.all) {
      if (
        !matcher ||
        !['log', 'hierarchy', 'fact'].includes(matcher.source) ||
        typeof matcher.pattern !== 'string' ||
        !matcher.pattern
      )
        throw new Error(`Invalid matcher in ${rule.id}`);
      if (
        matcher.source === 'fact' &&
        !['selectorMissing', 'resetExpected', 'isolatedRerunPassed'].includes(
          matcher.pattern,
        )
      )
        throw new Error(`Invalid fact in ${rule.id}`);
      if (matcher.source !== 'fact')
        new RegExp(
          matcher.pattern.replace(
            /\{\{(?:appPackage|expectedScreen)\}\}/g,
            'value',
          ),
          'i',
        );
    }
  }
  return set;
}

const defaultRules = validateRules(ruleData);
const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyFailure(
  input: ClassifierInput,
  rules: RuleSet = defaultRules,
): ClassificationVerdict {
  const checked = validateRules(rules);
  for (const rule of [...checked.rules].sort(
    (a, b) => b.precedence - a.precedence,
  )) {
    const evidence: string[] = [];
    let matched = true;
    for (const matcher of rule.all) {
      if (matcher.source === 'fact') {
        if (
          input[
            matcher.pattern as
              | 'selectorMissing'
              | 'resetExpected'
              | 'isolatedRerunPassed'
          ] !== true
        ) {
          matched = false;
          break;
        }
        evidence.push(`${matcher.pattern}=true`);
        continue;
      }
      let missing = false;
      const pattern = matcher.pattern.replace(
        /\{\{(appPackage|expectedScreen)\}\}/g,
        (_, key: 'appPackage' | 'expectedScreen') => {
          const value = input[key];
          if (!value) {
            missing = true;
            return '';
          }
          return escapeRegex(value);
        },
      );
      if (missing) {
        matched = false;
        break;
      }
      const regex = new RegExp(pattern, 'i');
      const line = (input[matcher.source] ?? '')
        .split(/\r?\n/)
        .find((item) => regex.test(item));
      if (line === undefined) {
        matched = false;
        break;
      }
      evidence.push(line);
    }
    if (matched)
      return {
        status: rule.status ?? 'fail',
        classification: rule.classification,
        ruleId: rule.id,
        ruleVersion: checked.version,
        evidence,
        artifacts: [...input.artifacts],
      };
  }
  return {
    status: 'fail',
    ruleVersion: checked.version,
    evidence: [],
    artifacts: [...input.artifacts],
  };
}
