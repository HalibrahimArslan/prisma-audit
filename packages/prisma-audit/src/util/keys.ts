/**
 * Primary keys, as both the runtime and the AuditReader have to speak about
 * them.
 *
 * A model's key is a *vector* of column values rather than a single scalar:
 * `@id` gives a vector of one, `@@id([orderId, lineNo])` a vector of two. Every
 * `where` clause prisma-audit builds is derived from that vector here, so the
 * composite case is handled in one place instead of at each call site.
 */

import type { AuditModel } from "../metadata.js";

/** The value of every key column of a row, keyed by column name. */
export type EntityKey = Record<string, unknown>;

/** `true` when the model's key spans more than one column. */
export function isComposite(model: AuditModel): boolean {
  return model.primaryKey.length > 1;
}

/**
 * Pull the key out of a row, or `null` when the row is missing a key column —
 * which happens when a caller's `select` left one out.
 */
export function keyOf(model: AuditModel, row: unknown): EntityKey | null {
  if (!row || typeof row !== "object") return null;

  const key: EntityKey = {};

  for (const column of model.primaryKey) {
    const value = (row as Record<string, unknown>)[column];
    if (value === undefined) return null;
    key[column] = value;
  }

  return key;
}

/**
 * A stable string for a key, used to recognise a row that is touched more than
 * once in the same revision. Column order comes from the schema, so two keys
 * for the same row always render identically.
 */
export function keyIdentity(model: AuditModel, key: EntityKey): string {
  return model.primaryKey.map((column) => `${column}=${String(key[column])}`).join("&");
}

/**
 * How the key reads in an error message: `id 10`, or `orderId 1, lineNo 2`.
 */
export function describeKey(model: AuditModel, key: EntityKey): string {
  return model.primaryKey.map((column) => `${column} ${String(key[column])}`).join(", ");
}

/** The key columns as a Prisma `select`, e.g. `{ orderId: true, lineNo: true }`. */
export function keySelect(model: AuditModel): Record<string, true> {
  return Object.fromEntries(model.primaryKey.map((column) => [column, true]));
}

/**
 * A `where` that identifies exactly one row of the source model.
 *
 * Prisma exposes a composite key as a single nested argument named after its
 * columns — `where: { orderId_lineNo: { orderId, lineNo } }` — or after the
 * `name:` given to `@@id`.
 */
export function whereUnique(model: AuditModel, key: EntityKey): Record<string, unknown> {
  if (!isComposite(model)) return { ...key };
  return { [compoundName(model)]: { ...key } };
}

/**
 * A `where` matching a known set of rows.
 *
 * A single-column key becomes `IN (...)`. A composite key has no such form, so
 * the keys are listed as alternatives; the database still resolves each one
 * through the primary key index.
 */
export function whereAnyOf(model: AuditModel, keys: EntityKey[]): Record<string, unknown> {
  const [column] = model.primaryKey;

  if (!isComposite(model)) {
    return { [column as string]: { in: keys.map((key) => key[column as string]) } };
  }

  return { OR: keys.map((key) => ({ ...key })) };
}

/**
 * A `where` for one audit row: the generated audit model is keyed
 * `@@id([revisionId, ...key])`, which Prisma names `revisionId_orderId_lineNo`.
 */
export function whereAuditRow(
  model: AuditModel,
  revisionId: bigint,
  key: EntityKey,
): Record<string, unknown> {
  const name = ["revisionId", ...model.primaryKey].join("_");
  return { [name]: { revisionId, ...key } };
}

/**
 * The key a caller's own `where` names, or `null` when it does not pin one down.
 *
 * Both shapes Prisma accepts are read: the flat `{ id: 10 }` of a single-column
 * key, and the nested `{ orderId_lineNo: { … } }` of a composite one.
 */
export function keyFromWhere(model: AuditModel, where: unknown): EntityKey | null {
  if (!where || typeof where !== "object") return null;

  if (!isComposite(model)) return keyOf(model, where);

  const compound = (where as Record<string, unknown>)[compoundName(model)];
  return keyOf(model, compound);
}

/**
 * How many rows fit in one statement, given that a composite key spends one
 * bind parameter per column. Databases cap parameters per statement, so a bulk
 * write over a large table is read back and recorded in batches of this size.
 */
export function batchSize(model: AuditModel, limit: number): number {
  return Math.max(1, Math.floor(limit / Math.max(1, model.primaryKey.length)));
}

/** The name Prisma Client gives the compound key argument. */
function compoundName(model: AuditModel): string {
  return model.primaryKeyName ?? model.primaryKey.join("_");
}
