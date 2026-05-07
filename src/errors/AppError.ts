export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly userMessage: string,
    options?: ErrorOptions
  ) {
    super(userMessage, options);
  }
}

export class ConcurrencyError extends AppError {
  constructor(
    message = "Reservation is not pending, has expired, or belongs to another user"
  ) {
    super(409, "LOCK_CONFLICT", message);
    this.name = "ConcurrencyError";
  }
}
