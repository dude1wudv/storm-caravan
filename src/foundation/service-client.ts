import { encodeJson, type JsonValue } from './json';
import { ORIGINAL_APK_SHA256 } from './original-data';

export interface ServiceBinding<T> {
  /** Set only after the original route and response contract are traced. */
  path: string;
  method: 'GET' | 'POST';
  sourceApkSha256: string;
  sourceLocator: string;
  parseResponse(value: unknown): T;
}
export class ServiceUnavailable extends Error {
  constructor(readonly reason: 'not-configured' | 'http-error' | 'invalid-response', readonly status?: number) {
    super(`Service unavailable: ${reason}${status === undefined ? '' : ` (${status})`}`);
  }
}

/** Must enforce redirect:error before issuing any redirected request (RN global fetch does not). */
export type ServiceTransport = (url: string, options: {
  method: 'GET' | 'POST';
  body?: string;
  headers: Record<string, string>;
  credentials: 'omit';
  redirect: 'error';
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; url: string; redirected: boolean; json(): Promise<unknown> }>;

/** Transport only; no original protocol, account credential or server success is fabricated. */
export class ServiceClient {
  private readonly base: URL | null;
  constructor(baseUrl: string | null, private readonly send: ServiceTransport, private readonly timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid service timeout');
    this.base = baseUrl === null ? null : new URL(baseUrl);
    if (this.base && (this.base.protocol !== 'https:' || this.base.username || this.base.password || this.base.search || this.base.hash)) {
      throw new Error('Service base must be HTTPS without credentials, query or fragment');
    }
    if (this.base && !this.base.pathname.endsWith('/')) this.base.pathname += '/';
  }

  async request<T>(binding: ServiceBinding<T>, body?: JsonValue, signal?: AbortSignal): Promise<T> {
    if (!this.base) throw new ServiceUnavailable('not-configured');
    if (binding.sourceApkSha256 !== ORIGINAL_APK_SHA256 || !binding.sourceLocator.trim()) throw new Error('Service contract lacks original provenance');
    if (!binding.path || binding.path.startsWith('/') || binding.path.includes('\\') || binding.path.includes('#')) throw new Error('Service path must be relative to the configured base');
    const url = new URL(binding.path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname) || url.username || url.password) {
      throw new Error('Service path escapes the configured base');
    }
    if (binding.method !== 'GET' && binding.method !== 'POST') throw new Error('Unsupported service method');
    if (binding.method === 'GET' && body !== undefined) throw new Error('GET service request cannot have a body');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      // Do not retry mutations or forward ambient cookies to a replacement server.
      const response = await this.send(url.toString(), {
        method: binding.method,
        body: body === undefined ? undefined : encodeJson(body),
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.redirected || response.url && response.url !== url.toString()) throw new ServiceUnavailable('invalid-response');
      if (!response.ok) throw new ServiceUnavailable('http-error', response.status);
      const value: unknown = await response.json();
      try {
        return binding.parseResponse(value);
      } catch {
        throw new ServiceUnavailable('invalid-response');
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
