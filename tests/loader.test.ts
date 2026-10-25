import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFeatures } from '../lib/loader';
import { defaults, resolve } from '../lib/settings';

afterEach(() => vi.restoreAllMocks());

describe('startFeatures', () => {
  it('starts an enabled feature with its own options', () => {
    const chatHotkeys = vi.fn();
    const status = startFeatures(resolve({ 'chatHotkeys.searchKey': false }), { chatHotkeys });
    expect(status).toEqual({ chatHotkeys: 'on' });
    expect(chatHotkeys).toHaveBeenCalledWith({ chatKey: true, searchKey: false });
  });

  it('does not start a disabled feature', () => {
    const chatHotkeys = vi.fn();
    expect(startFeatures(resolve({ chatHotkeys: false }), { chatHotkeys })).toEqual({ chatHotkeys: 'off' });
    expect(chatHotkeys).not.toHaveBeenCalled();
  });

  it('keeps going when one feature throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const latency = vi.fn();
    const status = startFeatures(defaults(), {
      chatHotkeys: () => {
        throw new Error('Twitch changed');
      },
      latency,
    });
    expect(status).toEqual({ latency: 'on', chatHotkeys: 'error' });
    expect(latency).toHaveBeenCalled();
  });
});
