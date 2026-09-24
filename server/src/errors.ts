export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`);
export const forbidden = (message = 'You do not have access to this action.') => new AppError(403, 'forbidden', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
