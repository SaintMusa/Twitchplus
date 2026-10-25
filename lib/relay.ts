// Cross-site requests for page-context features (link cards), which cannot make them themselves: the page posts a
// request to the bridge content script, which asks the background worker to fetch it.
// Any script on twitch.tv can post these messages too, so the background only does what link cards needs:
// anonymous GETs to public https addresses, with a size cap and a timeout.

export const REQUEST = 'twitchPlus.fetch';
export const RESULT = 'twitchPlus.fetchResult';

export interface FetchRequest {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface FetchResult {
  status: number;
  text: string;
  finalUrl: string;
  /** "name: value" lines, as GM_xmlhttpRequest's responseHeaders. */
  headers: string;
  error?: 'network' | 'timeout' | 'blocked';
}

const MAX_TIMEOUT = 15_000;
const MAX_BYTES = 3_000_000;
const ALLOWED_HEADERS = new Set(['accept', 'accept-language']);

/** True for https URLs on public host names; local, private and IP-literal hosts are refused. */
export function isPublicHttps(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IPv4 / IPv6 literals: no legitimate link-card source needs them, and they reach private networks.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return false;
  return true;
}

/** Runs in the background worker. */
export async function performFetch(request: FetchRequest): Promise<FetchResult> {
  const blocked: FetchResult = { status: 0, text: '', finalUrl: request.url, headers: '', error: 'blocked' };
  if (typeof request?.url !== 'string' || !isPublicHttps(request.url)) return blocked;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (ALLOWED_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name] = value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(request.timeout) || MAX_TIMEOUT, MAX_TIMEOUT));
  try {
    const response = await fetch(request.url, { method: 'GET', headers, credentials: 'omit', redirect: 'follow', signal: controller.signal });
    // Redirects are followed by fetch; refuse one that lands somewhere private.
    if (!isPublicHttps(response.url)) return { ...blocked, finalUrl: response.url };
    const text = await readCapped(response);
    const lines = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\r\n');
    return { status: response.status, text, finalUrl: response.url, headers: lines };
  } catch {
    return { status: 0, text: '', finalUrl: request.url, headers: '', error: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  void reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, all.length - offset);
    all.set(part, offset);
    offset += part.length;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

interface GmDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  onload?: (response: { status: number; responseText: string; finalUrl: string; responseHeaders: string }) => void;
  onerror?: () => void;
  ontimeout?: () => void;
}

let nextId = 0;
const pending = new Map<number, GmDetails>();
let listening = false;

/** Page side: the subset of GM_xmlhttpRequest that link cards uses (GET, anonymous, the four response fields). */
export function gmRequest(details: GmDetails) {
  if (!listening) {
    listening = true;
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== RESULT) return;
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      const result = event.data.result as FetchResult;
      if (result.error === 'timeout') job.ontimeout?.();
      else if (result.error) job.onerror?.();
      else job.onload?.({ status: result.status, responseText: result.text, finalUrl: result.finalUrl, responseHeaders: result.headers });
    });
  }
  const id = ++nextId;
  pending.set(id, details);
  // If nothing answers (no bridge, extension reloaded), give up a little after the background would have.
  setTimeout(() => {
    if (!pending.delete(id)) return;
    details.ontimeout?.();
  }, Math.min(Number(details.timeout) || MAX_TIMEOUT, MAX_TIMEOUT) + 2_000);
  const request: FetchRequest = { url: details.url, headers: details.headers, timeout: details.timeout };
  window.postMessage({ type: REQUEST, id, request }, location.origin);
}
