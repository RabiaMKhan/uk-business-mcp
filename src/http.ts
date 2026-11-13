/**
 * Shared HTTP helper and the error type whose message is safe to show the model.
 */

/** An error whose message is safe and useful to show to the model/user. */
export class UserFacingError extends Error {}

const TIMEOUT_MS = 10_000;

/**
 * fetch with a timeout, and a friendly error when the service can't be reached.
 * Always set a timeout on outbound calls, or one slow API hangs your tool forever.
 */
export async function fetchWithTimeout(url: URL, serviceName: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new UserFacingError(`${serviceName} ${reason}. Please try again.`, { cause: err });
  }
}
