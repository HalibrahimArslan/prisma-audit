/**
 * Reading rows back by key, which both the bulk paths and the nested-write
 * paths have to do, and always in batches: databases cap the number of bind
 * parameters in one statement, so a write over a large table is read back a
 * chunk at a time.
 */

import type { AuditModel } from "../metadata.js";
import { batchSize, whereAnyOf, type EntityKey } from "../util/keys.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** How many single-column keys go into one statement. */
export const CHUNK_SIZE = 1000;

/** The full rows behind a set of keys, in whatever order the database returns. */
export async function readByKeys(
  client: AnyClient,
  model: AuditModel,
  keys: EntityKey[],
): Promise<Record<string, unknown>[]> {
  if (keys.length === 0) return [];

  const rows: Record<string, unknown>[] = [];

  for (const chunk of chunks(keys, batchSize(model, CHUNK_SIZE))) {
    rows.push(...(await client[model.delegate].findMany({ where: whereAnyOf(model, chunk) })));
  }

  return rows;
}

export function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
