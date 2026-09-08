/**
 * Writing SQL by hand, safely.
 *
 * Everything prisma-audit emits is DDL built from schema metadata rather than
 * from user input at runtime, but the names in that metadata still come from a
 * file someone edits, so they are quoted rather than interpolated raw.
 */

/**
 * PostgreSQL truncates an identifier longer than this, silently, which would
 * turn two generated function names into one.
 */
export const MAX_IDENTIFIER_LENGTH = 63;

/** `product_aud` -> `"product_aud"`, with any embedded quote doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `it's` -> `'it''s'`, for a literal inside generated SQL. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A `text[]` literal, which is how the generated SQL passes a list of names. */
export function textArray(values: string[]): string {
  return `ARRAY[${values.map(quoteLiteral).join(", ")}]::text[]`;
}
