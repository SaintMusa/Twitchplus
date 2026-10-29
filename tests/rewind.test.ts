import { afterEach, describe, expect, it, vi } from 'vitest';
import rewind from '../lib/modules/rewind';

// Twitch's DVR gate module, copied as served. Rewind finds it by content and wraps its exports by role.
// Hand-verified build: getters in require.d's second argument.
const GETTER_BUILD = `(e,t,n)=>{"use strict";n.d(t,{Hl:()=>d,Sw:()=>l,TV:()=>s,fh:()=>c});var i=n(571421);const r="savvy-part-1",a="savvy-part-1-flag",o="savvy-part-2",s=()=>i.Mv.getAssignment(r,"boolean",!1),c=(e,t,n,a)=>{var s;if(a)return i.Mv.getAssignment(r,"boolean",!1);if(n.isDvrEligible)return!0;if(!(t.isAffiliate||t.isPartner))return!1;if(i.Mv.getAssignment(o,"boolean",!1))return!0;return(e.hasTurbo||e.isStaff||!(!e.subscription||!(null===(s=e.subscription.product)||void 0===s?void 0:s.hasAdFree)))&&i.Mv.getAssignment(r,"boolean",!1)},l=()=>i.Mv.getAssignment(a,"boolean",!1)||i.Mv.getAssignment(o,"boolean",!1),d=e=>(e.isAffiliate||e.isPartner)&&(i.Mv.getAssignment(a,"boolean",!1)||i.Mv.getAssignment(o,"boolean",!1))}`;
// Build live in October 2026: values in require.d's third argument, plus NV, fP and av (a savvy-part-2 check
// that also reads isAffiliate, like the channel check).
const VALUE_BUILD = `function(e,t,n){"use strict";var i=n(742940);let r="savvy-part-1",s="savvy-part-1-flag",a="savvy-part-2",o=()=>i.Mv.getAssignment(a,"boolean",!1);n.d(t,{},{Hl:e=>(e.isAffiliate||e.isPartner)&&(i.Mv.getAssignment(s,"boolean",!1)||i.Mv.getAssignment(a,"boolean",!1)),NV:()=>i.Mv.getAssignment(a,"boolean",!1),Sw:()=>i.Mv.getAssignment(s,"boolean",!1)||i.Mv.getAssignment(a,"boolean",!1),TV:()=>i.Mv.getAssignment(r,"boolean",!1)||o(),av:e=>!!o()&&(!!e.isParticipatingDJ||e.isAffiliate||e.isPartner),fP:o,fh:(e,t,n,s)=>s?i.Mv.getAssignment(r,"boolean",!1):!!n.isDvrEligible||!!(t.isAffiliate||t.isPartner)&&(!!i.Mv.getAssignment(a,"boolean",!1)||(e.hasTurbo||e.isStaff||!!(e.subscription&&e.subscription.product?.hasAdFree))&&i.Mv.getAssignment(r,"boolean",!1))})}`;

/** Starts Rewind in a stand-in page, delivers the module the way a Twitch chunk does, and runs it. */
function load(source: string) {
  const win: Record<string, any> = { fetch: async () => new Response('{}') };
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { pathname: '/somechannel', href: 'https://www.twitch.tv/somechannel' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'twitchNativeRewind.debug' ? '1' : null) });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rewind({});
  const factory = new Function(`return ${source}`)();
  const modules: Record<string, Function> = { 273200: factory };
  win.webpackChunktwitch_twilight.push([[1], modules]);
  // Every experiment off, as for a viewer outside Twitch's rollout.
  const require = Object.assign(() => ({ Mv: { getAssignment: () => false } }), {
    d(target: object, getters: Record<string, () => unknown>, values?: Record<string, unknown>) {
      for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { enumerable: true, get });
      for (const [name, value] of Object.entries(values ?? {})) Object.defineProperty(target, name, { enumerable: true, value });
    },
  });
  const exports: Record<string, any> = {};
  modules[273200]!.call(exports, { exports }, exports, require);
  // Getter builds settle on first use; the value build settles while exporting.
  void exports.fh;
  return { exports, report: win.__twitchRewindReport() };
}

const affiliate = { isAffiliate: true, isPartner: false };
const viewer = { hasTurbo: false, isStaff: false, subscription: null };

describe('rewind DVR gate', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('unlocks DVR in the hand-verified getter build', () => {
    const { exports, report } = load(GETTER_BUILD);
    expect(report.patch.state).toBe('active');
    expect(exports.fh(viewer, affiliate, { isDvrEligible: false }, false)).toBe(true);
    expect(exports.Hl(affiliate)).toBe(true);
  });

  it('unlocks DVR in the value build and leaves its savvy-part-2 checks native', () => {
    const { exports, report } = load(VALUE_BUILD);
    expect(report.patch.state).toBe('active');
    expect(exports.fh(viewer, affiliate, { isDvrEligible: false }, false)).toBe(true);
    expect(exports.Hl(affiliate)).toBe(true);
    expect(exports.TV()).toBe(true);
    // Native with part 2 off: false whatever the channel.
    expect(exports.av({ ...affiliate, isParticipatingDJ: true })).toBe(false);
    expect(exports.NV()).toBe(false);
    expect(exports.fP()).toBe(false);
  });

  it('keeps the native module when a channel check cannot be told apart', () => {
    // Two one-argument isAffiliate checks with nothing else to tell them apart.
    const { exports, report } = load(VALUE_BUILD.replace('!!e.isParticipatingDJ||', ''));
    expect(report.patch.state).toBe('unsupported-build');
    expect(exports.fh(viewer, affiliate, { isDvrEligible: false }, false)).toBe(false);
  });
});
