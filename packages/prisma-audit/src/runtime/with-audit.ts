import { AuditReader } from "../reader/audit-reader.js";
import { runWithAuditContext, type AuditUser } from "./context.js";
import { resolveEnforcement } from "./enforcement.js";
import {
  buildQueryExtension,
  openRevision,
  resolveUser,
  type AuditOptions,
  type PrismaClientLike,
} from "./extension.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

export interface AuditTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: unknown;
}

/** The methods `withAudit` adds to a Prisma Client. */
export interface AuditableClientExtras {
  /**
   * Run a unit of work under a single revision.
   *
   * Every audited write inside the callback is recorded against one `Revision`
   * row and shares its transaction, which is what makes a multi-model change
   * read as one event in the history — the same guarantee Envers gives.
   *
   *     await prisma.$auditTransaction({ userId: "42", username: "halil" }, async (tx) => {
   *       await tx.product.update({ where: { id: 1 }, data: { price: 55000 } });
   *       await tx.stock.update({ where: { id: 7 }, data: { count: 3 } });
   *     });
   */
  $auditTransaction<T>(
    fn: (tx: any) => Promise<T>,
    options?: AuditTransactionOptions,
  ): Promise<T>;
  $auditTransaction<T>(
    user: AuditUser,
    fn: (tx: any) => Promise<T>,
    options?: AuditTransactionOptions,
  ): Promise<T>;

  /** The read side: `prisma.audit.for("Product").id(10).getRevisions()`. */
  audit: AuditReader;
}

export type AuditablePrismaClient<C> = C & AuditableClientExtras;

/**
 * Wrap a Prisma Client so that writes to `[Auditable]` models are recorded.
 *
 *     const prisma = withAudit(new PrismaClient(), {
 *       metadata: loadMetadata("prisma/.audit/audit.metadata.json"),
 *       userProvider: () => currentUser(),
 *     });
 */
export function withAudit<C extends PrismaClientLike>(
  client: C,
  options: AuditOptions,
): AuditablePrismaClient<C> {
  // The query extension has to dispatch back through the *extended* client, but
  // that client only exists once `$extends` returns. The box is filled in
  // immediately afterwards and is only ever read from inside a query callback.
  const box = { client: undefined as unknown as AnyClient };

  // Both halves of the client resolve this the same way, and both do it here
  // rather than per transaction: it cannot change once the client is built.
  const enforcement = resolveEnforcement(options);

  // The reader is handed to the client extension before the extended client
  // exists, so it reads through the box rather than capturing a client.
  const reader = new AuditReader(
    new Proxy({} as AnyClient, { get: (_target, prop) => box.client[prop] }),
    options.metadata,
  );

  const extended = (client.$extends(buildQueryExtension(box, options)) as AnyClient).$extends({
    name: "prisma-audit-api",
    client: {
      audit: reader,

      async $auditTransaction(
        userOrFn: AuditUser | ((tx: AnyClient) => Promise<unknown>),
        fnOrOptions?: ((tx: AnyClient) => Promise<unknown>) | AuditTransactionOptions,
        maybeOptions?: AuditTransactionOptions,
      ) {
        const hasUser = typeof userOrFn !== "function";

        const fn = (hasUser ? fnOrOptions : userOrFn) as (tx: AnyClient) => Promise<unknown>;
        const txOptions = (hasUser ? maybeOptions : fnOrOptions) as
          | AuditTransactionOptions
          | undefined;

        if (typeof fn !== "function") {
          throw new TypeError("$auditTransaction requires a callback function.");
        }

        const user = hasUser ? (userOrFn as AuditUser) : await resolveUser(options);

        return box.client.$transaction(async (tx: AnyClient) => {
          const revision = await openRevision(tx, enforcement, user);

          // Awaited inside the scope on purpose: Prisma model calls are lazy,
          // so an unawaited promise would execute after the context had been
          // left and the write would look unaudited.
          return runWithAuditContext(
            { user, revisionId: revision.id, tx, written: new Map() },
            async () => {
              return await fn(tx);
            },
          );
        }, txOptions);
      },
    },
  });

  box.client = extended;

  return extended as AuditablePrismaClient<C>;
}
