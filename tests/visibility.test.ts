import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHidden } from '../lib/visibility';

describe('real tab visibility', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sees through an always-visible fake on the document object', () => {
    // Chrome's getter lives on Document.prototype; ad blocking defines its own on the document object.
    let real = 'hidden';
    class FakeDocument {}
    Object.defineProperty(FakeDocument.prototype, 'visibilityState', { configurable: true, get: () => real });
    const document = new FakeDocument();
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { get: () => false });
    vi.stubGlobal('Document', FakeDocument);
    vi.stubGlobal('document', document);

    expect((document as { visibilityState: string }).visibilityState).toBe('visible');
    expect(isHidden()).toBe(true);
    real = 'visible';
    expect(isHidden()).toBe(false);
  });
});
