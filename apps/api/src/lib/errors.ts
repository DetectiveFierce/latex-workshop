export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (message = 'Resource not found') =>
  new HttpError(404, 'NOT_FOUND', message);
export const forbidden = () =>
  new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource');
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'CONFLICT', message, details);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const quotaExceeded = (message: string) => new HttpError(413, 'QUOTA_EXCEEDED', message);
