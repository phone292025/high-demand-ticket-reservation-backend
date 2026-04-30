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
