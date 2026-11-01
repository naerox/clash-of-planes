// `catch (err)` hands us `unknown`: anything can be thrown. These helpers narrow it once.

/** The human-readable text of whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The stack of an Error, or the text of anything else. */
export function errorStack(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : String(err);
}
