export interface ApiErrorBody { error?: { code?: string; message?: string }; }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private csrfToken = '';

  setCsrfToken(token: string): void { this.csrfToken = token; }

  async request<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string } = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = new URL(`/api/v1${path}`, window.location.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = this.csrfToken;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    let response: Response;
    try {
      response = await fetch(url, { method, credentials: 'include', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    } catch {
      throw new ApiError('Il server web non è raggiungibile. Verifica che bot e backend siano avviati.', 0, 'RETE_NON_DISPONIBILE');
    }
    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => null) as ApiErrorBody | T | null;
    if (!response.ok) {
      const error = payload && typeof payload === 'object' && 'error' in payload ? (payload as ApiErrorBody).error : undefined;
      throw new ApiError(error?.message ?? `Richiesta non riuscita (${response.status}).`, response.status, error?.code);
    }
    return payload as T;
  }

  async download(path: string): Promise<Blob> {
    const url = new URL(`/api/v1${path}`, window.location.origin);
    let response: Response;
    try { response = await fetch(url, { credentials: 'include', headers: { Accept: 'text/plain' } }); }
    catch { throw new ApiError('Il server web non è raggiungibile. Verifica che bot e backend siano avviati.', 0, 'RETE_NON_DISPONIBILE'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiErrorBody | null;
      throw new ApiError(payload?.error?.message ?? `Download non riuscito (${response.status}).`, response.status, payload?.error?.code);
    }
    return response.blob();
  }
}

export const api = new ApiClient();
