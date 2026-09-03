import type { ApiError } from '@latex-workshop/contracts';

export const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function appPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${APP_BASE}${normalized}`;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasJsonBody = init.body !== undefined && !(init.body instanceof FormData);
  const response = await fetch(appPath(path), {
    ...init,
    credentials: 'include',
    headers: { ...(hasJsonBody ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const body = type.includes('json') ? ((await response.json()) as ApiError) : null;
    throw new ApiClientError(
      response.status,
      body?.error.code ?? 'REQUEST_FAILED',
      body?.error.message ?? response.statusText,
      body?.error.details,
    );
  }
  return (type.includes('json') ? response.json() : response.blob()) as Promise<T>;
}

export function uploadForm<T>(
  path: string,
  body: FormData,
  onProgress: (percent: number | null) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', appPath(path));
    request.withCredentials = true;
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    });
    request.upload.addEventListener('load', () => onProgress(null));
    request.addEventListener('error', () =>
      reject(new ApiClientError(0, 'NETWORK_ERROR', 'The upload could not reach the server')),
    );
    request.addEventListener('load', () => {
      const type = request.getResponseHeader('content-type') ?? '';
      let body: unknown = null;
      if (type.includes('json') && request.responseText) {
        try {
          body = JSON.parse(request.responseText);
        } catch {
          body = null;
        }
      }
      if (request.status < 200 || request.status >= 300) {
        const apiError = body as ApiError | null;
        reject(
          new ApiClientError(
            request.status,
            apiError?.error.code ?? 'REQUEST_FAILED',
            apiError?.error.message ?? request.statusText ?? 'Import failed',
            apiError?.error.details,
          ),
        );
        return;
      }
      resolve(body as T);
    });
    request.send(body);
  });
}

export const queryKeys = {
  projects: (trash = false) => ['projects', trash] as const,
  library: (trash = false) => ['library', trash] as const,
  templates: ['templates'] as const,
  project: (id: string) => ['project', id] as const,
  compiles: (id: string) => ['compiles', id] as const,
  checkpoints: (id: string) => ['checkpoints', id] as const,
  keyboardShortcuts: (userId: string) => ['keyboard-shortcuts', userId] as const,
};
