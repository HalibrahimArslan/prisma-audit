/**
 * Auditing the rows a nested write reaches.
 *
 * `product.update({ data: { stocks: { create: … } } })` writes rows of a second
 * model, and the extension never sees an operation of its own for them: Prisma
 * resolves the whole payload in one call. Rather than take the payload apart and
 * re-issue it — which would mean prisma-audit rewriting the caller's query, and
 * guessing at foreign keys, `connectOrCreate` and implicit many-to-many — the
 * statement is left exactly as written and the rows it could touch are read
 * before and after it.
 *
 * What that comparison can say is precise, because every row the write could
 * reach is known beforehand: the rows already related to the parent, plus the
 * ones the payload names outright. A key that appears only afterwards was
 * created; one that disappeared was deleted; one on both sides was updated, and
 * if nothing about it changed there is nothing to record.
 *
 * The cost is two extra reads per nested relation, paid only by a write that
 * actually carries a nested payload.
 */

import {
  auditedFields,
  type AuditField,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
import { keyFromWhere, keyIdentity, keyOf, type EntityKey } from "../util/keys.js";
import { resolveRelationLink, type RelationLink } from "../util/relations.js";
import { sameValue } from "../util/values.js";
import { readByKeys } from "./read.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** Keys inside a relation payload that write, or point at, rows of that model. */
const NESTED_WRITE_KEYS = [
  "create",
  "createMany",
  "connectOrCreate",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "connect",
  "disconnect",
  "set",
];

/** The operations whose arguments can carry a nested write at all. */
export const NESTS = new Set(["create", "update", "upsert"]);

/** One audited relation a write reaches, and how to find its rows. */
export interface NestedPlan {
  field: AuditField;
  target: AuditModel;
  link: RelationLink;
  /** Rows the payload names by key: `connect`, `set`, `update`, `delete`, … */
  namedKeys: EntityKey[];
}

/** An audited relation a write reaches that prisma-audit cannot follow. */
export interface NestedGap {
  relation: string;
  target: string;
}

export interface NestedScan {
  plans: NestedPlan[];
  gaps: NestedGap[];
}

const NO_NESTED_WRITES: NestedScan = { plans: [], gaps: [] };

/**
 * What a write's arguments reach beyond the model it is called on.
 *
 * Returns nothing at all in the common case, which is what keeps an ordinary
 * write on the cheap path.
 */
export function scanNestedWrites(
  metadata: AuditMetadata,
  parent: AuditModel,
  operation: string,
  args: any,
): NestedScan {
  if (!NESTS.has(operation)) return NO_NESTED_WRITES;

  const payloads = [args?.data, args?.create, args?.update].filter(
    (payload) => payload && typeof payload === "object" && !Array.isArray(payload),
  );

  if (payloads.length === 0) return NO_NESTED_WRITES;

  const plans = new Map<string, NestedPlan>();
  const gaps: NestedGap[] = [];

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      if (!NESTED_WRITE_KEYS.some((nested) => nested in (value as object))) continue;

      const field = parent.fields.find(
        (candidate) => candidate.name === key && candidate.kind === "relation",
      );
      if (!field) continue;

      const target = metadata.models.find((model) => model.name === field.type);
      if (!target?.auditable) continue;

      const link = resolveRelationLink(field, parent, target);
      if (!link) {
        gaps.push({ relation: key, target: target.name });
        continue;
      }

      const plan = plans.get(key) ?? { field, target, link, namedKeys: [] };
      plan.namedKeys.push(...namedKeys(target, value as Record<string, unknown>));
      plans.set(key, plan);
    }
  }

  return plans.size === 0 && gaps.length === 0
    ? NO_NESTED_WRITES
    : { plans: [...plans.values()], gaps };
}

/**
 * The keys a nested payload names outright.
 *
 * `connect`, `set`, `disconnect`, `update`, `delete` and `upsert` all identify
 * their rows by key, which is what makes a row that was connected rather than
 * created recognisable: it is already known before the write, so it cannot be
 * mistaken for an insert afterwards. `createMany`, `updateMany` and `deleteMany`
 * name no keys, but they only ever touch rows already related to the parent.
 */
function namedKeys(target: AuditModel, payload: Record<string, unknown>): EntityKey[] {
  const found: EntityKey[] = [];

  for (const value of Object.values(payload)) {
    for (const candidate of [value].flat()) {
      if (!candidate || typeof candidate !== "object") continue;

      const entry = candidate as Record<string, unknown>;
      const key = keyFromWhere(target, entry) ?? keyFromWhere(target, entry.where);

      if (key) found.push(key);
    }
  }

  return found;
}

/** The rows a nested write could touch, as they stood before it ran. */
export interface NestedSnapshot {
  plan: NestedPlan;
  before: Map<string, Record<string, unknown>>;
}

/**
 * Read the rows in reach of the write.
 *
 * For a relation the child owns, that is every row currently pointing at the
 * parent; for one the parent owns, the single row the parent points at. A
 * `create` has no parent row yet, so only the keys the payload names can be
 * related to it beforehand.
 */
export async function snapshotNested(
  client: AnyClient,
  parent: AuditModel,
  operation: string,
  args: any,
  plans: NestedPlan[],
): Promise<NestedSnapshot[]> {
  const parentRow =
    operation === "create" ? null : await readParentJoinColumns(client, parent, args, plans);

  return Promise.all(
    plans.map(async (plan) => {
      const rows = [
        ...(parentRow ? await readRelated(client, plan, parentRow) : []),
        ...(await readByKeys(client, plan.target, plan.namedKeys)),
      ];

      return { plan, before: byKey(plan.target, rows) };
    }),
  );
}

/**
 * Compare what is there now with what was there before, and turn the difference
 * into audit rows.
 */
export async function recordNested(
  client: AnyClient,
  snapshots: NestedSnapshot[],
  parentRow: Record<string, unknown>,
): Promise<Array<{ model: AuditModel; entries: Array<{ state: any; revType: string }> }>> {
  const recorded = [];

  for (const { plan, before } of snapshots) {
    const related = await readRelated(client, plan, parentRow);
    const after = byKey(plan.target, related);

    // A row that was in reach before may no longer be related — deleted, or
    // just disconnected — so it is looked up by key rather than by relation.
    const missing = [...before]
      .filter(([identity]) => !after.has(identity))
      .map(([, row]) => keyOf(plan.target, row) as EntityKey);

    for (const row of await readByKeys(client, plan.target, missing)) {
      after.set(identityOf(plan.target, row), row);
    }

    const entries = compare(plan.target, before, after);
    if (entries.length > 0) recorded.push({ model: plan.target, entries });
  }

  return recorded;
}

function compare(
  target: AuditModel,
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): Array<{ state: any; revType: string }> {
  const entries: Array<{ state: any; revType: string }> = [];

  for (const [identity, state] of after) {
    const previous = before.get(identity);

    if (!previous) {
      entries.push({ state, revType: "INSERT" });
    } else if (changed(target, previous, state)) {
      entries.push({ state, revType: "UPDATE" });
    }
  }

  for (const [identity, state] of before) {
    if (!after.has(identity)) entries.push({ state, revType: "DELETE" });
  }

  return entries;
}

/**
 * Whether an audited column of the row holds a different value than it did.
 *
 * A row can be in reach of a nested write without being written to — every row
 * of the relation is read, not just the ones the payload names — so only an
 * actual change is recorded. Connecting a row across an implicit many-to-many
 * changes none of its own columns, and reads as no change here.
 */
function changed(
  target: AuditModel,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return auditedFields(target).some(
    (field) => !sameValue(before[field.name], after[field.name]),
  );
}

/** The rows on the other side of the relation, as they stand for `parentRow`. */
async function readRelated(
  client: AnyClient,
  plan: NestedPlan,
  parentRow: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const { link, target } = plan;

  if (link.kind === "child-owns") {
    const where: Record<string, unknown> = {};

    for (const column of link.columns) {
      const value = parentRow[column.parent];
      // The parent has no value to join on, so nothing can point at it yet.
      if (value === undefined || value === null) return [];
      where[column.child] = value;
    }

    return client[target.delegate].findMany({ where });
  }

  // The parent holds the foreign key, so it points at one row at most.
  const key: EntityKey = {};

  for (const column of link.columns) {
    const value = parentRow[column.parent];
    if (value === undefined || value === null) return [];
    key[column.child] = value;
  }

  return readByKeys(client, target, [key]);
}

/**
 * The parent's join columns as they stand before the write, which is what says
 * who is related to it right now.
 */
async function readParentJoinColumns(
  client: AnyClient,
  parent: AuditModel,
  args: any,
  plans: NestedPlan[],
): Promise<Record<string, unknown> | null> {
  const select: Record<string, true> = {};

  for (const plan of plans) {
    for (const column of plan.link.columns) select[column.parent] = true;
  }

  return client[parent.delegate].findUnique({ where: args?.where, select });
}

function byKey(
  target: AuditModel,
  rows: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  return new Map(rows.map((row) => [identityOf(target, row), row]));
}

function identityOf(target: AuditModel, row: Record<string, unknown>): string {
  return keyIdentity(target, keyOf(target, row) ?? {});
}
