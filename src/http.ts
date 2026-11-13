/**
 * Shared HTTP helper and the error type whose message is safe to show the model.
 */
import type { ZodType } from "zod";

/** An error whose message is safe and useful to show to the model/user. */
export class UserFacingError extends Error {}

const TIMEOUT_MS = 10_000;

export interface GetJsonOptions {
  /** Service name for error messages, e.g. "Companies House". */
  service: string;
  headers?: Record<string, string>;
  /** Messages for HTTP statuses that need their own explanation, e.g. 401 or 429. */
  statusMessages?: Partial<Record<number, string>>;
}

/**
 * GET a JSON API and check the body against `schema`. Returns null on 404.
 *
 * Every other failure becomes a UserFacingError that names the service: network error,
 * timeout, unreadable body or an unexpected shape. The 10 s timeout also covers reading
 * the body, so one slow API can't hang a tool. Zod drops every field the schema doesn't
 * list, so data we don't need never reaches the model.
 */
export async function getJson<T>(url: URL, schema: ZodType<T>, options: GetJsonOptions): Promise<T | null> {
  const { service } = options;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...options.headers }, signal });
  } catch (err) {
    throw failure(service, err, "could not be reached");
  }

  if (res.status === 404) return null;
  const statusMessage = options.statusMessages?.[res.status];
  if (statusMessage) throw new UserFacingError(statusMessage);
  if (!res.ok) throw new UserFacingError(`${service} returned HTTP ${res.status}. Please try again later.`);

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw failure(service, err, "sent a response that could not be read");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new UserFacingError(`${service} sent data in an unexpected format. Please try again later.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Turns a low-level error into a safe message. Timeouts get their own wording. */
function failure(service: string, err: unknown, reason: string): UserFacingError {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  return new UserFacingError(`${service} ${timedOut ? "timed out" : reason}. Please try again.`, { cause: err });
}
