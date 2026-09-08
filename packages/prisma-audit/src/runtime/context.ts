import { AsyncLocalStorage } from "node:async_hooks";

import type { RevisionId } from "../metadata.js";

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
  revisionId?: RevisionId;
  /**
   * The transaction client that both the source write and the audit write run
   * on, so the two either commit together or roll back together.
   */
  tx?: unknown;
  /**
   * Rows already audited in this revision, keyed `Model#id`, holding the
   * revision type they were written with.
   *
   * An audit table is keyed `(revisionId, id)`, so a row touched twice in the
   * same revision has to update its existing audit record rather than insert a
   * second one. The map also lets the common case stay fast: when none of the
   * rows in a batch have been seen, they can all be inserted at once.
   */
  written?: Map<string, string>;
  /**
   * Set while prisma-audit re-dispatches an operation on the client for its own
   * purposes, so the interceptor lets that call straight through instead of
   * auditing it a second time.
   */
  bypass?: boolean;
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
