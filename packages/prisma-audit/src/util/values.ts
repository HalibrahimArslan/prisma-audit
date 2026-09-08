/**
 * Value equality that is good enough for auditing: `Decimal`, `BigInt` and
 * `Date` all compare correctly through their string form, while plain scalars
 * fall back to `Object.is`.
 *
 * It decides both what `diff()` reports and, for a nested write, whether a row
 * changed at all — the two questions have to be answered the same way.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (typeof a === "object" || typeof b === "object") {
    return String(a) === String(b);
  }

  return false;
}
