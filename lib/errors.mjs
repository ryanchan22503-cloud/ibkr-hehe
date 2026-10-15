export class AppError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    Object.assign(this, { code, status, details });
  }
}
