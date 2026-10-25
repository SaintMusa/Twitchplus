import { describe, expect, it } from 'vitest';
import { isPublicHttps, performFetch } from '../lib/relay';

describe('relay address check', () => {
  it('allows public https sites', () => {
    expect(isPublicHttps('https://braize.pajlada.com/chatterino/link_resolver/x')).toBe(true);
    expect(isPublicHttps('https://www.youtube.com/watch?v=1')).toBe(true);
  });

  it('refuses http, local, private and IP-literal addresses', () => {
    for (const url of [
      'http://example.com/',
      'https://localhost/',
      'https://app.localhost/',
      'https://printer.local/',
      'https://intranet/',
      'https://192.168.1.1/',
      'https://127.0.0.1:8080/',
      'https://[::1]/',
      'https://user:pass@example.com/',
      'javascript:alert(1)',
      'not a url',
    ]) expect(isPublicHttps(url), url).toBe(false);
  });

  it('does not fetch a refused address', async () => {
    const result = await performFetch({ url: 'https://127.0.0.1/' });
    expect(result.error).toBe('blocked');
  });
});
