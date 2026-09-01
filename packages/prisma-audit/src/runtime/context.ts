import { AsyncLocalStorage } from "node:async_hooks";

/** Who performed the change. Supplied by the application, not by Prisma. */
export interface AuditUser {
  userId?: string;
  username?: string;
}

export interface AuditContext {
  user?: AuditUser;
  /**
   * The revision every audit row written inside this scope belongs to.
   * One transaction produces exactly one revision, the way Envers does it.
   */
  revisionId?: bigint;
  /**
   * The transaction client that both the source write and the audit write run
   * on, so the two either commit together or roll back together.
   */
  tx?: unknown;
}

const storage = new AsyncLocalStorage<AuditContext>();

/** Run `fn` with an audit context visible to every Prisma call it makes. */
export function runWithAuditContext<T>(
  context: AuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/** The audit context of the current async scope, or an empty one. */
export function getAuditContext(): AuditContext {
  return storage.getStore() ?? {};
}

/** `true` while a revision is open, i.e. inside `$auditTransaction`. */
export function hasOpenRevision(): boolean {
  return storage.getStore()?.revisionId !== undefined;
}
