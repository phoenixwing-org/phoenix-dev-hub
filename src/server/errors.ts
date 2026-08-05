export class DevHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DevHubError";
  }
}
