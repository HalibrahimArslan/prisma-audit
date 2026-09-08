import { triggerBackedModels, type AuditModel } from "../metadata.js";
import {
  SETTING_REVISION_ID,
  SETTING_SUPPRESS,
  SETTING_USER_ID,
  SETTING_USERNAME,
  SUPPRESS_ON,
} from "../util/settings.js";
import type { AuditUser } from "./context.js";
// Type-only, so the cycle with extension.ts exists for the type checker alone
// and never for the module loader.
import type { AuditOptions } from "./extension.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** The one provider the generated triggers are written for. */
const POSTGRESQL = "postgresql";

/**
 * How this build and the database's triggers divide the work of recording.
 *
 * - `auto` — the metadata decides, model by model: a `[AuditTriggers]` model's
 *   audit rows are the trigger's to write, every other model's are the
 *   runtime's. This is the default, and it is what a build generated from the
 *   same schema as the installed SQL wants.
 * - `suppress` — the runtime writes every audit row itself and tells the
 *   triggers to stand down. This is the deploy window: the SQL is installed but
 *   the build that relies on it is not out yet, or has been rolled back.
 * - `off` — the runtime writes every audit row itself and says nothing to the
 *   database at all. Correct only where no trigger is installed; with one
 *   installed and not suppressed, both halves would record the same write.
 */
export type TriggerMode = "auto" | "suppress" | "off";

/** What the runtime publishes on a transaction, and who writes the audit rows. */
export interface Enforcement {
  /**
   * `true` while the runtime is writing every audit row itself, which is what
   * the triggers are told so they do not record the same write twice.
   */
  suppress: boolean;
}

/**
 * Whether the runtime has anything to say to the database about triggers.
 *
 * `undefined` means it has not — no trigger is in play, so no transaction pays
 * for a setting nothing reads. That is the answer for every schema that does
 * not use `[AuditTriggers]`, which is why this costs the ordinary user nothing.
 */
export function resolveEnforcement(options: AuditOptions): Enforcement | undefined {
  const mode = options.triggers ?? "auto";
  if (mode === "off") return undefined;

  const provider = options.provider ?? options.metadata.provider;
  const backed = triggerBackedModels(options.metadata).length > 0;

  if (mode === "suppress") {
    if (provider !== POSTGRESQL) {
      throw new Error(
        `triggers: "suppress" writes a PostgreSQL transaction-local setting, and this client is configured for ${provider ?? "no"} provider.`,
      );
    }
    return { suppress: true };
  }

  if (!backed) return undefined;

  if (provider !== POSTGRESQL) {
    throw new Error(
      `The metadata marks models as [AuditTriggers], which is PostgreSQL-only, and this client is configured for ${provider ?? "no"} provider. Regenerate the metadata, or pass triggers: "off".`,
    );
  }

  return { suppress: false };
}

/**
 * Whether a model's audit rows are the database's to write.
 *
 * Under suppression they never are: the triggers have been told to stand down,
 * so the runtime writes the rows for every model, marked or not.
 */
export function triggerWrites(
  enforcement: Enforcement | undefined,
  model: AuditModel,
): boolean {
  return enforcement !== undefined && !enforcement.suppress && model.triggers === true;
}

/**
 * Carry the revision down to the database, for the length of this transaction.
 *
 * A trigger cannot see the call stack, so the revision it should attach a row
 * to and the user who caused it travel on the transaction itself. Publishing
 * the revision is also what makes a write the runtime records and one a trigger
 * records land in the *same* revision when a transaction does both.
 *
 * `set_config(..., true)` scopes each setting to the current transaction and
 * reverts it at the end, so nothing leaks to the next unit of work that
 * borrows the same pooled connection.
 */
export async function publishRevision(
  tx: AnyClient,
  enforcement: Enforcement,
  revisionId: bigint,
  user: AuditUser | undefined,
): Promise<void> {
  // An absent user is published as the empty string rather than left unset:
  // a setting reverted at the end of an earlier transaction already reads as
  // the empty string, and the generated SQL turns both into NULL.
  const settings: Array<[string, string]> = [
    [SETTING_REVISION_ID, revisionId.toString()],
    [SETTING_USER_ID, user?.userId ?? ""],
    [SETTING_USERNAME, user?.username ?? ""],
    [SETTING_SUPPRESS, enforcement.suppress ? SUPPRESS_ON : ""],
  ];

  // One statement, so a revision costs one round trip however many settings it
  // carries. The values are bound rather than interpolated.
  const calls = settings
    .map((_setting, index) => `set_config($${String(index * 2 + 1)}, $${String(index * 2 + 2)}, true)`)
    .join(", ");

  await tx.$queryRawUnsafe(`SELECT ${calls}`, ...settings.flat());
}
