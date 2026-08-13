// Diagnostic rules engine (§5). Verdicts are the product's soul: not "here is
// data" but "here is what is wrong and why."
//
// Rulepacks are declarative YAML so field-discovered failure signatures can be
// added without recompiling. Each Diagnose() run feeds a fact object into the
// matching rulepack; rules evaluate top-to-bottom and matched verdicts attach
// to the artifact with severity + optional next_steps.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class RulesEngine {
  constructor({ dir }) {
    this.dir = dir;
    this.packs = new Map(); // rulepack id -> parsed pack
    this.load();
  }

  // Hot-loadable: re-read every .yaml in the rulepack dir.
  load() {
    this.packs.clear();
    if (!fs.existsSync(this.dir)) return;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      try {
        const doc = yaml.load(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (doc && doc.rulepack) {
          this.packs.set(doc.rulepack, { ...doc, _file: f });
        }
      } catch (err) {
        // A bad rulepack must not take the engine down; report and skip.
        console.error(`[rules] failed to load ${f}: ${err.message}`);
      }
    }
    return this.packs.size;
  }

  listPacks() {
    return [...this.packs.values()].map((p) => ({
      rulepack: p.rulepack,
      rules: (p.rules || []).length,
      file: p._file,
    }));
  }

  // Evaluate a fact object against a named rulepack. Returns matched verdicts,
  // most-severe-first. `all` false (default) stops at the first match per the
  // top-to-bottom semantics; a rule with `continue: true` keeps evaluating.
  evaluate(rulepackId, facts) {
    const pack = this.packs.get(rulepackId);
    if (!pack) return [];
    const verdicts = [];
    for (const rule of pack.rules || []) {
      if (matchWhen(rule.when || {}, facts)) {
        const v = rule.verdict || {};
        verdicts.push({
          rule_id: rule.id,
          severity: v.severity || 'info',
          title: v.title || rule.id,
          detail: (v.detail || '').trim(),
          next_steps: v.next_steps || [],
        });
        if (!rule.continue) break;
      }
    }
    return verdicts;
  }
}

// A `when` block is an AND of conditions. Each condition addresses a dotted path
// into the fact object; the value it's compared against may be a literal or a
// small operator object.
function matchWhen(when, facts) {
  for (const [pathExpr, expected] of Object.entries(when)) {
    const actual = getPath(facts, pathExpr);
    if (!matchValue(actual, expected)) return false;
  }
  return true;
}

function matchValue(actual, expected) {
  // Operator forms: { gt }, { gte }, { lt }, { lte }, { ne }, { in: [...] },
  // { exists: true|false }, { any: [...] }.
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('exists' in expected) return expected.exists ? actual !== undefined && actual !== null : actual === undefined || actual === null;
    if ('gt' in expected) return num(actual) > expected.gt;
    if ('gte' in expected) return num(actual) >= expected.gte;
    if ('lt' in expected) return num(actual) < expected.lt;
    if ('lte' in expected) return num(actual) <= expected.lte;
    if ('ne' in expected) return actual !== expected.ne;
    if ('in' in expected) return Array.isArray(expected.in) && expected.in.includes(actual);
    if ('any' in expected) return Array.isArray(expected.any) && expected.any.some((e) => matchValue(actual, e));
    return false;
  }
  // Literal comparison. `none`/null both match "absent".
  if (expected === 'none' || expected === null) {
    return actual === undefined || actual === null || actual === 'none';
  }
  return actual === expected;
}

function getPath(obj, expr) {
  let cur = obj;
  for (const part of String(expr).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
