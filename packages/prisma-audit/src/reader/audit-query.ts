import { auditedFields, type AuditMetadata, type AuditModel } from "../metadata.js";
import { isComposite, keyOf, type EntityKey } from "../util/keys.js";
import { sameValue } from "../util/values.js";
import { AggregateQuery } from "./aggregate-query.js";

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
  private key: EntityKey | undefined;

  constructor(
    private readonly client: AnyClient,
    private readonly metadata: AuditMetadata,
    private readonly model: AuditModel,
  ) {}

  /**
   * Restrict the query to one row of the source model.
   *
   * A single-column key is given as the value itself; a composite key as an
   * object naming every column, `id({ orderId: 1, lineNo: 2 })`. Both forms are
   * exactly what `AuditReader.revisions()` reports for a change, so a summary
   * can be handed straight back to `.id()`.
   */
  id(value: unknown): this {
    this.key = this.toKey(value);
    return this;
  }

  /**
   * Read this row together with the rows that belong to it: the relations
   * marked `[AuditedRelation]`, or the ones named here.
   *
   *     await prisma.audit.for("Order").id(1).aggregate().atRevision(120n);
   */
  aggregate(...relations: string[]): AggregateQuery<T> {
    return new AggregateQuery<T>(
      this.client,
      this.metadata,
      this.model,
      this.whereId(),
      (revisionId) => this.atRevision(revisionId),
      relations,
    );
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
    if (!this.key) {
      throw new Error(`Call .id(...) before querying the history of ${this.model.name}.`);
    }
    // The audit table carries the key columns as ordinary columns, so they
    // filter flatly here even when the source model's key is composite.
    return { ...this.key };
  }

  /** Read the argument of `.id()` as a full key, or explain what is missing. */
  private toKey(value: unknown): EntityKey {
    const columns = this.model.primaryKey;
    const fromObject = keyOf(this.model, value);

    if (fromObject) return fromObject;

    // A single-column key is normally passed as the bare value — which may
    // itself be an object, e.g. a `DateTime` or a `Bytes` key.
    if (!isComposite(this.model) && value !== undefined) {
      return { [columns[0] as string]: value };
    }

    throw new Error(
      `${this.model.name} has a composite primary key, so .id() needs every column: ` +
        `.id({ ${columns.map((column) => `${column}: …`).join(", ")} })`,
    );
  }

  /** Split a raw audit row into revision bookkeeping and entity state. */
  private toEntry(row: any): AuditRevisionEntry<T> {
    const entity = toEntity(this.model, row);

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
 * The entity half of an audit row: the columns of the source model, without the
 * revision bookkeeping the audit table adds alongside them.
 */
export function toEntity(
  model: AuditModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const entity: Record<string, unknown> = {};

  for (const field of auditedFields(model)) {
    entity[field.name] = row[field.name];
  }

  return entity;
}
