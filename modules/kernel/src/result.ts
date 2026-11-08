/** Typed error + outcome union for fallible cross-module calls (MODULAR_DESIGN §1/§4). */
export class StewartError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StewartError";
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: StewartError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: string, message: string, cause?: unknown): Result<never> {
  return { ok: false, error: new StewartError(code, message, { cause }) };
}

export function isErr<T>(r: Result<T>): r is { ok: false; error: StewartError } {
  return !r.ok;
}

/** Wrap a throwing call; the error's `cause` keeps the original. */
export function fromThrowable<T>(code: string, fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(code, e instanceof Error ? e.message : String(e), e);
  }
}
