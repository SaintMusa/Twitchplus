import { describe, expect, it } from 'vitest';
import { roleOf } from '../lib/modules/preferred-quality';

// Stand-ins for Twitch's minified modules: only the strings the fingerprints look for.
const SETTINGS_BODY = `"video-muted" segmentKey "video-quality" "clips-editing","clips-viewing" n.x2.storage.get(e,{}) n.x2.storage.set(e,o)`;
const CREATOR_BODY = `"player-core-base" "ivs-player-core-distribution" mediaPlayerInstance y.a.INITIALIZED e.getExperiments()`;

describe('preferred quality module matching', () => {
  it('finds the settings module with the old getter export', () => {
    expect(roleOf(`(e,t,n)=>{n.d(t,{o:()=>a});${SETTINGS_BODY}}`)).toBe('settings');
  });

  it('finds the settings module with the newer value export', () => {
    expect(roleOf(`function(e,t,i){${SETTINGS_BODY};i.d(t,{},{o:{get:function(e,t){},set:function(){}}})}`)).toBe('settings');
  });

  it('finds the player creator', () => {
    expect(roleOf(`function(e,i,n){n.d(i,{F:()=>T});${CREATOR_BODY}}`)).toBe('creator');
  });

  it('ignores modules missing a marker or the export', () => {
    expect(roleOf(`n.d(t,{o:()=>a});${SETTINGS_BODY.replace('segmentKey', '')}`)).toBeNull();
    expect(roleOf(`n.d(i,{G:()=>T});${CREATOR_BODY}`)).toBeNull();
    expect(roleOf('')).toBeNull();
  });
});
