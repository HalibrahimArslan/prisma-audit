import {
  auditedFields,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
import {
  getAuditContext,
  runWithAuditContext,
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

/** Operations whose result is the complete row, so they can be audited today. */
const AUDITED_OPERATIONS = new Set(["create", "update", "delete"]);

/**
 * Write operations that touch audited models but are not recorded yet. They
 * either affect many rows at once or branch at runtime, so they need a
 * read-before-write strategy of their own.
 */
const UNSUPPORTED_OPERATIONS = new Set([
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
  "upsert",
]);

const REV_TYPE: Record<string, string> = {
  create: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

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
  /** Called once per unsupported operation. Default: `console.warn`. */
  onUnsupportedOperation?: (model: string, operation: string) => void;
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

  const auditModel = findAuditable(options.metadata, model);
  if (!auditModel) return query(args);

  if (!AUDITED_OPERATIONS.has(operation)) {
    if (UNSUPPORTED_OPERATIONS.has(operation)) {
      warnUnsupported(options, warned, model, operation);
    }
    return query(args);
  }

  const context = getAuditContext();

  if (context.revisionId === undefined) {
    const policy = options.onMissingRevision ?? "transaction";

    if (policy === "skip") return query(args);
    if (policy === "error") {
      throw new Error(
        `${model}.${operation}() was called outside $auditTransaction(), so it cannot be audited. ` +
          `Wrap the call in prisma.$auditTransaction(), or set onMissingRevision to "transaction" or "skip".`,
      );
    }

    return openRevisionFor(box, options, auditModel, operation, args);
  }

  return record(options, auditModel, operation, args, query, context.revisionId, context.tx);
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
    return runWithAuditContext({ user, revisionId: revision.id, tx }, async () => {
      return await tx[model.delegate][operation](args);
    });
  });
}

/** Run the operation, then write its audit row on the same transaction. */
async function record(
  options: AuditOptions,
  model: AuditModel,
  operation: string,
  args: any,
  query: (args: any) => Promise<any>,
  revisionId: bigint,
  tx: unknown,
): Promise<unknown> {
  const client = tx as AnyClient;
  const projected = usesProjection(args);

  // A projected delete cannot be reconstructed afterwards — the row is gone.
  const before =
    operation === "delete" && projected
      ? await client[model.delegate].findUnique({ where: args.where })
      : null;

  const result = await query(args);

  const state = await resolveState(client, model, operation, args, result, before, projected);

  await client[model.auditDelegate].create({
    data: {
      revisionId,
      revType: REV_TYPE[operation],
      ...pickAuditedFields(model, state),
    },
  });

  return result;
}

/**
 * The full row as it stands after the operation.
 *
 * Prisma returns the complete record for `create`, `update` and `delete`, so
 * the common case needs no extra query. A caller-supplied `select`/`omit`
 * narrows that result, and the row is re-read to fill the audit table.
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

  const primaryKey = model.primaryKey as string;
  const id = result?.[primaryKey] ?? args?.where?.[primaryKey];

  if (id === undefined) {
    throw new Error(
      `${model.name}.${operation}() uses select/omit without returning ${primaryKey}, ` +
        `so prisma-audit cannot re-read the row. Include ${primaryKey} in the selection.`,
    );
  }

  return (await client[model.delegate].findUnique({ where: { [primaryKey]: id } })) ?? {};
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

function findAuditable(metadata: AuditMetadata, modelName: string): AuditModel | undefined {
  const model = metadata.models.find((candidate) => candidate.name === modelName);
  return model?.auditable ? model : undefined;
}

function warnUnsupported(
  options: AuditOptions,
  warned: Set<string>,
  model: string,
  operation: string,
): void {
  const key = `${model}.${operation}`;
  if (warned.has(key)) return;
  warned.add(key);

  if (options.onUnsupportedOperation) {
    options.onUnsupportedOperation(model, operation);
    return;
  }

  console.warn(
    `[prisma-audit] ${key}() is not audited yet; the rows it changes will have no revision history.`,
  );
}
