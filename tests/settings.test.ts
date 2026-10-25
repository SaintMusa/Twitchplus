import { describe, expect, it } from 'vitest';
import { FEATURES } from '../lib/features';
import { MODULES } from '../lib/modules';
import { defaults, optionsOf, parse, resolve } from '../lib/settings';

describe('settings', () => {
  it('has a default for every feature and option', () => {
    const d = defaults();
    expect(d.chatHotkeys).toBe(true);
    expect(d['chatHotkeys.searchKey']).toBe(true);
    expect(d['adBlock.supported']).toEqual([]);
  });

  it('keeps stored values of the right type and drops the rest', () => {
    const s = resolve({ chatHotkeys: false, 'quality.ceiling': 720, unknown: true, 'adBlock.supported': ['a', 1] });
    expect(s.chatHotkeys).toBe(false);
    expect(s['quality.ceiling']).toBe('source');
    expect(s['adBlock.supported']).toEqual([]);
    expect('unknown' in s).toBe(false);
  });

  it('falls back to defaults on a broken mirror', () => {
    expect(parse('{not json')).toEqual(defaults());
    expect(parse(null)).toEqual(defaults());
  });

  it('gives a module only its own options', () => {
    expect(optionsOf(defaults(), 'chatHotkeys')).toEqual({ chatKey: true, searchKey: true });
  });
});

describe('features', () => {
  it('has unique ids', () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a module exactly for the ready features', () => {
    for (const f of FEATURES) expect(f.id in MODULES, f.id).toBe(f.ready);
  });
});
