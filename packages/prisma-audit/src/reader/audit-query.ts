import { auditedFields, type AuditModel } from "../metadata.js";

export type RevisionType = "INSERT" | "UPDATE" | "DELETE";

/** One point in a row's history: what it looked like, who changed it, when. */
export interface AuditRevisionEntry<T = Record<string, unknown>> {
  revisionId: bigint;
  revType: RevisionType;
  timestamp: Date;
  user: { userId: string | null; username: string | null };
  /** The full state of the row as of this revision. */
  entity: T;
}

/** A single field's before/after across two revisions. */
export interface FieldChange {
  old: unknown;
  new: unknown;
}

export type EntityDiff = Record<string, FieldChange>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/**
 * A fluent query over one audited row's history, in the spirit of Envers'
 * `AuditQuery`.
 *
 *     await prisma.audit.for("Product").id(10).getRevisions();
 *     await prisma.audit.for("Product").id(10).atRevision(120n);
 */
export class AuditQuery<T = Record<string, unknown>> {
  private idValue: unknown;

  constructor(
    private readonly client: AnyClient,
    private readonly model: AuditModel,
  ) {}

  /** Restrict the query to one row of the source model. */
  id(value: unknown): this {
    this.idValue = value;
    return this;
  }

  /** Every recorded revision of the row, oldest first. */
  async getRevisions(): Promise<AuditRevisionEntry<T>[]> {
    const rows = await this.client[this.model.auditDelegate].findMany({
      where: this.whereId(),
      orderBy: { revisionId: "asc" },
      include: { revision: true },
    });

    return rows.map((row: any) => this.toEntry(row));
  }

  /** Alias of {@link getRevisions}, for readability at call sites. */
  getHistory(): Promise<AuditRevisionEntry<T>[]> {
    return this.getRevisions();
  }

  /**
   * The row as it stood at `revisionId`: the most recent audit record at or
   * before that revision. Returns `null` when the row did not exist yet, or
   * when it had already been deleted.
   */
  async atRevision(revisionId: bigint): Promise<AuditRevisionEntry<T> | null> {
    const rows = await this.client[this.model.auditDelegate].findMany({
      where: { ...this.whereId(), revisionId: { lte: revisionId } },
      orderBy: { revisionId: "desc" },
      take: 1,
      include: { revision: true },
    });

    const row = rows[0];
    if (!row) return null;
    if (row.revType === "DELETE") return null;

    return this.toEntry(row);
  }

  /** Revisions of the row within an inclusive revision range, oldest first. */
  async between(from: bigint, to: bigint): Promise<AuditRevisionEntry<T>[]> {
    const rows = await this.client[this.model.auditDelegate].findMany({
      where: { ...this.whereId(), revisionId: { gte: from, lte: to } },
      orderBy: { revisionId: "asc" },
      include: { revision: true },
    });

    return rows.map((row: any) => this.toEntry(row));
  }

  /**
   * What changed on the row between two revisions.
   *
   * Both sides are resolved with {@link atRevision}, so `from`/`to` do not have
   * to be revisions in which this particular row was touched. A row that did
   * not exist on one side is treated as an empty state, which makes the diff of
   * an INSERT or a DELETE read naturally.
   */
  async diff(from: bigint, to: bigint): Promise<EntityDiff> {
    const [before, after] = await Promise.all([
      this.stateAt(from),
      this.stateAt(to),
    ]);

    const diff: EntityDiff = {};

    for (const field of auditedFields(this.model)) {
      const oldValue = before[field.name] ?? null;
      const newValue = after[field.name] ?? null;

      if (!sameValue(oldValue, newValue)) {
        diff[field.name] = { old: oldValue, new: newValue };
      }
    }

    return diff;
  }

  private async stateAt(revisionId: bigint): Promise<Record<string, unknown>> {
    const entry = await this.atRevision(revisionId);
    return (entry?.entity as Record<string, unknown>) ?? {};
  }

  private whereId(): Record<string, unknown> {
    if (this.idValue === undefined) {
      throw new Error(
        `Call .id(...) before querying the history of ${this.model.name}.`,
      );
    }
    return { [this.model.primaryKey as string]: this.idValue };
  }

  /** Split a raw audit row into revision bookkeeping and entity state. */
  private toEntry(row: any): AuditRevisionEntry<T> {
    const entity: Record<string, unknown> = {};

    for (const field of auditedFields(this.model)) {
      entity[field.name] = row[field.name];
    }

    return {
      revisionId: row.revisionId,
      revType: row.revType,
      timestamp: row.revision.timestamp,
      user: {
        userId: row.revision.userId ?? null,
        username: row.revision.username ?? null,
      },
      entity: entity as T,
    };
  }
}

/**
 * Value equality that is good enough for audit diffs: `Decimal`, `BigInt` and
 * `Date` all compare correctly through their string form, while plain scalars
 * fall back to `Object.is`.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (typeof a === "object" || typeof b === "object") {
    return String(a) === String(b);
  }

  return false;
}
