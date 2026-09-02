import {
  auditedFields,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
import {
  batchSize,
  keyFromWhere,
  keyIdentity,
  keyOf,
  keySelect,
  whereAnyOf,
  whereAuditRow,
  whereUnique,
  type EntityKey,
} from "../util/keys.js";
import {
  recordNested,
  scanNestedWrites,
  snapshotNested,
  type NestedGap,
  type NestedPlan,
} from "./nested.js";
import { chunks, readByKeys, CHUNK_SIZE } from "./read.js";
import {
  getAuditContext,
  runWithAuditContext,
  type AuditContext,
  type AuditUser,
} from "./context.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/**
 * The Prisma Client surface this package needs. The generated client is
 * project-specific and not available to the library, so the runtime is typed
 * against this structural minimum and the caller's own client type is carried
 * through the generic in `withAudit`.
 *
 * The members are typed loosely on purpose: `$extends` is generic and heavily
 * overloaded in the generated client, and any narrower signature here would
 * fail to match it, which would silently widen `C` to this type and strip the
 * model delegates from the returned client.
 */
export type PrismaClientLike = {
  $extends: (...args: any[]) => any;
  $transaction: (...args: any[]) => any;
};

/** Writes that affect exactly one row. */
const SINGLE_ROW_OPERATIONS = new Set(["create", "update", "delete", "upsert"]);

/**
 * Writes that affect an unknown number of rows. Each one needs a read to learn
 * which rows it touched, because the statement itself only reports a count.
 */
const BULK_OPERATIONS = new Set([
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
]);

const REV_TYPE: Record<string, string> = {
  create: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

/** Providers whose `createManyAndReturn` also accepts `skipDuplicates`. */
const SKIP_DUPLICATES_PROVIDERS = new Set(["postgresql", "postgres", "cockroachdb"]);

/** Prisma's error code for a unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";

/**
 * What to do when an audited write happens outside `$auditTransaction`.
 *
 * - `transaction` opens a transaction for that single write, so the row and its
 *   audit record still commit together. This is the default.
 * - `skip` performs the write with no audit record.
 * - `error` refuses the write.
 */
export type MissingRevisionPolicy = "transaction" | "skip" | "error";

export interface AuditOptions {
  /** Parsed schema metadata, normally loaded from `audit.metadata.json`. */
  metadata: AuditMetadata;
  /** Supplies the acting user when the caller does not pass one explicitly. */
  userProvider?: () => AuditUser | undefined | Promise<AuditUser | undefined>;
  /** Default: `"transaction"`. */
  onMissingRevision?: MissingRevisionPolicy;
  /**
   * Overrides the `datasource` provider recorded in the metadata. Only affects
   * which strategy `createMany` uses, and is rarely needed.
   */
  provider?: string;
  /**
   * Called once per relation when a write reaches an audited model through a
   * nested payload that prisma-audit cannot follow — an implicit many-to-many,
   * or two relations to one model with no `@relation("name")` to tell them
   * apart. A nested write it *can* follow is audited, not reported here.
   * Default: `console.warn`.
   */
  onNestedWrite?: (model: string, relationField: string, targetModel: string) => void;
}

interface ClientBox {
  client: AnyClient;
}

interface OperationParams {
  model?: string;
  operation: string;
  args: any;
  query: (args: any) => Promise<any>;
}

/** One audit row waiting to be written: the row's state and how it got there. */
interface AuditEntry {
  state: Record<string, unknown>;
  revType: string;
}

/** What an audited operation produced: its own result, plus what to record. */
interface Outcome {
  result: unknown;
  entries: AuditEntry[];
  /**
   * The full row a single-row write left behind, which is what says who is
   * related to it now. Absent for a bulk write, which cannot nest.
   */
  parentState?: Record<string, unknown>;
}

export function buildQueryExtension(box: ClientBox, options: AuditOptions) {
  const warned = new Set<string>();

  return {
    name: "prisma-audit",
    query: {
      $allModels: {
        async $allOperations(params: OperationParams) {
          return intercept(box, options, warned, params);
        },
      },
    },
  };
}

async function intercept(
  box: ClientBox,
  options: AuditOptions,
  warned: Set<string>,
  { model, operation, args, query }: OperationParams,
): Promise<unknown> {
  if (!model) return query(args);

  const source = options.metadata.models.find((candidate) => candidate.name === model);
  if (!source) return query(args);

  const isWrite =
    SINGLE_ROW_OPERATIONS.has(operation) || BULK_OPERATIONS.has(operation);
  if (!isWrite) return query(args);

  const context = getAuditContext();

  // A call prisma-audit made itself, to read back or re-issue the work of the
  // operation it is already recording. Auditing it again would duplicate rows.
  if (context.bypass) return query(args);

  const nested = scanNestedWrites(options.metadata, source, operation, args);
  warnNestedGaps(options, warned, source, operation, nested.gaps);

  // A model that is not itself audited still matters when the write reaches one
  // that is, e.g. `category.update({ data: { products: { update: … } } })`.
  if (!source.auditable && nested.plans.length === 0) return query(args);

  if (context.revisionId === undefined) {
    const policy = options.onMissingRevision ?? "transaction";

    if (policy === "skip") return query(args);
    if (policy === "error") {
      throw new Error(
        `${model}.${operation}() was called outside $auditTransaction(), so it cannot be audited. ` +
          `Wrap the call in prisma.$auditTransaction(), or set onMissingRevision to "transaction" or "skip".`,
      );
    }

    return openRevisionFor(box, options, source, operation, args);
  }

  return record(options, source, operation, args, query, context, nested.plans);
}

/**
 * An audited write with no revision open: start a transaction, open a revision
 * and re-issue the very same call on the transaction client. The re-issued call
 * lands back here with a revision in context and takes the `record` path, so
 * the row and its audit record share one transaction.
 */
async function openRevisionFor(
  box: ClientBox,
  options: AuditOptions,
  model: AuditModel,
  operation: string,
  args: any,
): Promise<unknown> {
  const user = await resolveUser(options);

  return box.client.$transaction(async (tx: AnyClient) => {
    const revision = await createRevision(tx, user);

    // The operation must be awaited *inside* the context scope: a Prisma model
    // call returns a lazy promise, and if it were handed back unawaited it
    // would start executing after the scope had already been left. The
    // re-dispatch would then see no revision and open another transaction,
    // recursively, until the connection pool ran dry.
    return runWithAuditContext(
      { user, revisionId: revision.id, tx, written: new Map() },
      async () => {
        return await tx[model.delegate][operation](args);
      },
    );
  });
}

/** Run the operation, then write its audit rows on the same transaction. */
async function record(
  options: AuditOptions,
  model: AuditModel,
  operation: string,
  args: any,
  query: (args: any) => Promise<any>,
  context: AuditContext,
  plans: NestedPlan[],
): Promise<unknown> {
  const client = context.tx as AnyClient;

  // Read the rows the nested payload could touch before the write runs: once it
  // has, a row it deleted is beyond reach.
  const snapshots =
    plans.length > 0 ? await snapshotNested(client, model, operation, args, plans) : [];

  const outcome = !model.auditable
    ? { result: await query(args), entries: [] }
    : BULK_OPERATIONS.has(operation)
      ? await runBulk(options, client, model, operation, args, query)
      : await runSingleRow(client, model, operation, args, query);

  await writeAuditRows(client, model, context, outcome.entries);

  for (const nested of snapshots.length > 0
    ? await recordNested(client, snapshots, await parentState(client, model, args, outcome))
    : []) {
    await writeAuditRows(client, nested.model, context, nested.entries);
  }

  return outcome.result;
}

/**
 * The parent row as it stands after the write, which is what says who is
 * related to it now. An audited write has already resolved that state; an
 * unaudited one has whatever Prisma returned, re-read when `select` narrowed it.
 */
async function parentState(
  client: AnyClient,
  model: AuditModel,
  args: any,
  outcome: Outcome,
): Promise<Record<string, unknown>> {
  if (outcome.parentState) return outcome.parentState;

  const result = (outcome.result ?? {}) as Record<string, unknown>;
  if (!usesProjection(args)) return result;

  const key = keyOf(model, result) ?? keyFromWhere(model, args?.where);
  if (!key) return result;

  return (
    ((await client[model.delegate].findUnique({ where: whereUnique(model, key) })) as
      | Record<string, unknown>
      | null) ?? result
  );
}

/* -------------------------------------------------------------------------- */
/* Single-row writes                                                           */
/* -------------------------------------------------------------------------- */

async function runSingleRow(
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
  query: (args: any) => Promise<any>,
): Promise<Outcome> {
  const projected = usesProjection(args);

  // `upsert` branches inside the database, so the only way to know whether the
  // revision is an INSERT or an UPDATE is to look before the write.
  const existed =
    operation === "upsert" ? await rowExists(client, model, args?.where) : false;

  // A projected delete cannot be reconstructed afterwards — the row is gone.
  const before =
    operation === "delete" && projected
      ? await client[model.delegate].findUnique({ where: args.where })
      : null;

  const result = await query(args);

  const state = await resolveState(
    client,
    model,
    operation,
    args,
    result,
    before,
    projected,
  );

  const revType =
    operation === "upsert" ? (existed ? "UPDATE" : "INSERT") : (REV_TYPE[operation] as string);

  return { result, entries: [{ state, revType }], parentState: state };
}

async function rowExists(
  client: AnyClient,
  model: AuditModel,
  where: any,
): Promise<boolean> {
  const row = await client[model.delegate].findUnique({
    where,
    select: keySelect(model),
  });
  return row !== null && row !== undefined;
}

/**
 * The full row as it stands after the operation.
 *
 * Prisma returns the complete record for `create`, `update`, `upsert` and
 * `delete`, so the common case needs no extra query. A caller-supplied
 * `select`/`omit` narrows that result, and the row is re-read to fill the audit
 * table.
 */
async function resolveState(
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
  result: any,
  before: any,
  projected: boolean,
): Promise<Record<string, unknown>> {
  if (!projected) return (operation === "delete" ? (result ?? before) : result) ?? {};

  if (operation === "delete") {
    if (before) return before;
    throw new Error(
      `${model.name}.delete() with select/omit could not be audited: the row was not found before deletion.`,
    );
  }

  // The narrowed result may still carry the key; failing that, a single-row
  // write always names the row it targets in its own `where`.
  const key = keyOf(model, result) ?? keyFromWhere(model, args?.where);

  if (!key) throw new Error(missingKeyForReread(model, `${model.name}.${operation}()`, "row"));

  return (
    (await client[model.delegate].findUnique({ where: whereUnique(model, key) })) ?? {}
  );
}

/* -------------------------------------------------------------------------- */
/* Bulk writes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Bulk statements report a count, not the rows they touched, so each one is
 * paired with a read: before the write when the rows are about to disappear or
 * to stop matching the filter, after it when the new state is what matters.
 * That is the documented cost of auditing them — one statement becomes two.
 */
async function runBulk(
  options: AuditOptions,
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
  query: (args: any) => Promise<any>,
): Promise<Outcome> {
  switch (operation) {
    case "createMany":
      return createManyAudited(options, client, model, args);

    case "createManyAndReturn":
      return returnedRows(client, model, operation, args, await query(args), "INSERT");

    case "updateManyAndReturn":
      return returnedRows(client, model, operation, args, await query(args), "UPDATE");

    case "updateMany":
      return updateManyAudited(client, model, args, query);

    case "deleteMany":
      return deleteManyAudited(client, model, args, query);

    default:
      throw new Error(`prisma-audit has no strategy for ${model.name}.${operation}().`);
  }
}

/**
 * `createMany` reports only a count, and the rows carry database-generated
 * keys, so there is nothing to audit unless the insert gives the rows back.
 *
 * `createManyAndReturn` does exactly that, and Prisma only puts it on the
 * delegate for the databases that support it — which makes the delegate itself
 * the capability check. Everywhere else the insert is replayed row by row.
 */
async function createManyAudited(
  options: AuditOptions,
  client: AnyClient,
  model: AuditModel,
  args: any,
): Promise<Outcome> {
  if (canInsertReturning(options, client, model, args)) {
    const created: any[] = await runBypassed(client, model, "createManyAndReturn", args);
    return {
      result: { count: created.length },
      entries: created.map((state) => ({ state, revType: "INSERT" })),
    };
  }

  const rows = Array.isArray(args?.data) ? args.data : [args?.data];
  const created: any[] = [];

  for (const data of rows) {
    if (data === undefined) continue;

    try {
      created.push(await runBypassed(client, model, "create", { data }));
    } catch (error) {
      if (args?.skipDuplicates && isUniqueViolation(error)) continue;
      throw error;
    }
  }

  return {
    result: { count: created.length },
    entries: created.map((state) => ({ state, revType: "INSERT" })),
  };
}

function canInsertReturning(
  options: AuditOptions,
  client: AnyClient,
  model: AuditModel,
  args: any,
): boolean {
  if (typeof client[model.delegate]?.createManyAndReturn !== "function") return false;
  if (!args?.skipDuplicates) return true;

  // SQLite has `createManyAndReturn` but rejects `skipDuplicates` on it.
  const provider = options.provider ?? options.metadata.provider;
  return provider !== undefined && SKIP_DUPLICATES_PROVIDERS.has(provider);
}

/** An operation that already hands back the rows it wrote. */
async function returnedRows(
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
  result: any[],
  revType: string,
): Promise<Outcome> {
  const states = await hydrate(client, model, operation, args, result);
  return { result, entries: states.map((state) => ({ state, revType })) };
}

async function updateManyAudited(
  client: AnyClient,
  model: AuditModel,
  args: any,
  query: (args: any) => Promise<any>,
): Promise<Outcome> {
  const limited = args?.limit !== undefined;

  const targets: any[] = await client[model.delegate].findMany({
    where: args?.where,
    select: keySelect(model),
    ...(limited ? { take: args.limit } : {}),
  });

  const keys = targets.map((row) => keyOf(model, row) as EntityKey);

  // With `limit` the database decides which of the matching rows to touch, and
  // that need not be the set just read. Re-issuing the update against those
  // keys makes the two statements agree instead of hoping that they do.
  const result = limited
    ? await runBypassed(client, model, "updateMany", withKeyFilter(args, model, keys))
    : await query(args);

  const states = await readByKeys(client, model, keys);

  return { result, entries: states.map((state) => ({ state, revType: "UPDATE" })) };
}

async function deleteManyAudited(
  client: AnyClient,
  model: AuditModel,
  args: any,
  query: (args: any) => Promise<any>,
): Promise<Outcome> {
  const limited = args?.limit !== undefined;

  // Read the whole row, not just the key: after the delete there is nothing
  // left to go back for.
  const doomed: any[] = await client[model.delegate].findMany({
    where: args?.where,
    ...(limited ? { take: args.limit } : {}),
  });

  const result = limited
    ? await runBypassed(
        client,
        model,
        "deleteMany",
        withKeyFilter(
          args,
          model,
          doomed.map((row) => keyOf(model, row) as EntityKey),
        ),
      )
    : await query(args);

  return { result, entries: doomed.map((state) => ({ state, revType: "DELETE" })) };
}

/** The same arguments, narrowed to a fixed set of rows and without `limit`. */
function withKeyFilter(args: any, model: AuditModel, keys: EntityKey[]): any {
  const { limit: _limit, where: _where, ...rest } = args ?? {};
  return { ...rest, where: whereAnyOf(model, keys) };
}

/**
 * Fill in rows that came back narrowed by `select`/`omit`. The audit table
 * needs every audited column, so the rows are re-read by primary key.
 */
async function hydrate(
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
  rows: any[],
): Promise<Record<string, unknown>[]> {
  if (!usesProjection(args)) return rows ?? [];

  const keys = (rows ?? []).map((row) => keyOf(model, row));

  if (keys.some((key) => key === null)) {
    throw new Error(missingKeyForReread(model, `${model.name}.${operation}()`, "rows"));
  }

  return readByKeys(client, model, keys as EntityKey[]);
}

/** The one message both re-read paths need, naming every column of the key. */
function missingKeyForReread(model: AuditModel, call: string, rows: string): string {
  const columns = model.primaryKey.join(", ");
  return (
    `${call} uses select/omit without returning ${columns}, so prisma-audit cannot ` +
    `re-read the ${rows}. Include ${columns} in the selection.`
  );
}

/**
 * Re-dispatch an operation on the client for prisma-audit's own purposes. The
 * call goes through the extension again, so it is marked as a bypass to keep it
 * from being audited a second time.
 *
 * As everywhere else, the call is awaited inside the scope: a Prisma model call
 * is lazy, and an unawaited promise would run once the scope had been left.
 */
function runBypassed(
  client: AnyClient,
  model: AuditModel,
  operation: string,
  args: any,
): Promise<any> {
  const context = getAuditContext();

  return runWithAuditContext({ ...context, bypass: true }, async () => {
    return await client[model.delegate][operation](args);
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/* -------------------------------------------------------------------------- */
/* Writing the audit rows                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Write one audit row per changed row.
 *
 * An audit table is keyed `(revisionId, id)`, so a row touched twice in the
 * same revision updates the record it already has rather than inserting a
 * second one — the revision keeps the state the row ended up in. A row created
 * and then changed within one revision stays an INSERT, because that is what
 * the revision did to it.
 */
async function writeAuditRows(
  client: AnyClient,
  model: AuditModel,
  context: AuditContext,
  entries: AuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const revisionId = context.revisionId as bigint;
  const written = (context.written ??= new Map());

  /** Rows not yet in the audit table, so they can be inserted in one go. */
  const pending = new Map<string, Record<string, unknown>>();

  for (const entry of entries) {
    const key = keyOf(model, entry.state);

    if (!key) {
      throw new Error(
        `${model.name}: an audited write produced a row without ${model.primaryKey.join(", ")}, ` +
          `so it cannot be recorded.`,
      );
    }

    const identity = `${model.name}#${keyIdentity(model, key)}`;
    const previous = written.get(identity);
    const revType =
      previous === "INSERT" && entry.revType === "UPDATE" ? "INSERT" : entry.revType;

    const data = {
      revisionId,
      revType,
      ...pickAuditedFields(model, entry.state),
    };

    if (previous === undefined || pending.has(identity)) {
      pending.set(identity, data);
    } else {
      await client[model.auditDelegate].update({
        where: whereAuditRow(model, revisionId, key),
        data,
      });
    }

    written.set(identity, revType);
  }

  for (const chunk of chunks([...pending.values()], batchSize(model, CHUNK_SIZE))) {
    await client[model.auditDelegate].createMany({ data: chunk });
  }
}

function usesProjection(args: any): boolean {
  return Boolean(args?.select || args?.omit);
}

/** Copy across only the columns the audit table actually has. */
function pickAuditedFields(
  model: AuditModel,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of auditedFields(model)) {
    if (field.name in state) data[field.name] = state[field.name];
  }

  return data;
}

export async function createRevision(
  tx: AnyClient,
  user: AuditUser | undefined,
): Promise<{ id: bigint }> {
  return tx.revision.create({
    data: {
      userId: user?.userId ?? null,
      username: user?.username ?? null,
    },
  });
}

export async function resolveUser(options: AuditOptions): Promise<AuditUser | undefined> {
  return options.userProvider ? await options.userProvider() : undefined;
}

/**
 * A relation prisma-audit cannot follow: an implicit many-to-many names no join
 * columns, and two relations to one model with no `@relation("name")` cannot be
 * told apart. Rather than leave a silent hole in the history, say so once.
 */
function warnNestedGaps(
  options: AuditOptions,
  warned: Set<string>,
  model: AuditModel,
  operation: string,
  gaps: NestedGap[],
): void {
  for (const gap of gaps) {
    const id = `${model.name}.${gap.relation}`;
    if (warned.has(id)) continue;
    warned.add(id);

    if (options.onNestedWrite) {
      options.onNestedWrite(model.name, gap.relation, gap.target);
      continue;
    }

    console.warn(
      `[prisma-audit] ${model.name}.${operation}() writes ${gap.target} through the nested relation "${gap.relation}", ` +
        `whose join columns the schema does not name, so prisma-audit cannot find those rows to record them.`,
    );
  }
}
