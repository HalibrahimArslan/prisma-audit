/**
 * The transaction-local settings that carry a revision down to the database.
 *
 * A trigger cannot see the application's call stack, so the revision it should
 * attach a row to and the user who caused it have to travel on the transaction
 * itself. PostgreSQL calls these customised options; a custom one must carry a
 * dotted prefix, and `prisma_audit` is specific enough not to be claimed by
 * something else the way a bare `audit` would be.
 *
 * The runtime publishes them with `set_config(..., true)`, which scopes them to
 * the current transaction and reverts them when it ends. Both the SQL generator
 * and the runtime import these names, so the two cannot drift apart.
 */

/** The revision every audit row written in this transaction belongs to. */
export const SETTING_REVISION_ID = "prisma_audit.revision_id";

/** The acting user, as `AuditUser.userId`. */
export const SETTING_USER_ID = "prisma_audit.user_id";

/** The acting user, as `AuditUser.username`. */
export const SETTING_USERNAME = "prisma_audit.username";

/**
 * Set while the runtime is writing the audit rows itself, telling the triggers
 * to stand down.
 *
 * This is what lets the trigger migration and the build that relies on it be
 * two independent deploys: with the override on, Prisma writes are recorded by
 * the extension exactly as before while raw writes are already covered by the
 * triggers, and neither records a row twice.
 */
export const SETTING_SUPPRESS = "prisma_audit.suppress";

/** The one value `SETTING_SUPPRESS` is read for. */
export const SUPPRESS_ON = "on";
