/**
 * Reading an aggregate: a root row together with the rows that belong to it.
 *
 * An order and its lines change as one thing, and asking what the order looked
 * like at revision 120 is only half an answer without them. Nothing extra is
 * stored for this — the children's own audit tables already hold their full
 * state per revision, and the foreign key that ties them to the root is one of
 * the columns they store. Reconstruction is therefore a read: take the latest
 * state of each child at or before the revision, and keep the ones that still
 * pointed at this root and had not been deleted.
 */

import type { RevisionId } from "../metadata.js";
import {
  aggregateRelations,
  type AuditField,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
import { keyIdentity, keyOf, keySelect, whereAnyOf, type EntityKey } from "../util/keys.js";
import { resolveRelationLink, type RelationLink } from "../util/relations.js";
import { toEntity, type AuditRevisionEntry, type RevisionType } from "./audit-query.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** A root row at some revision, with the children it had at that revision. */
export interface AggregateEntry<T = Record<string, unknown>> extends AuditRevisionEntry<T> {
  /** The rows of each `[AuditedRelation]`, keyed by the relation's field name. */
  children: Record<string, Record<string, unknown>[]>;
}

/** A revision that changed the root or one of its children. */
export interface AggregateRevision {
  revisionId: RevisionId;
  timestamp: Date;
  user: { userId: string | null; username: string | null };
  changes: Array<{
    model: string;
    /** The relation the change came through; absent for the root itself. */
    relation?: string;
    id: unknown;
    revType: RevisionType;
  }>;
}

interface AggregateChild {
  field: AuditField;
  target: AuditModel;
  link: RelationLink;
}

/**
 * The read side of an aggregate.
 *
 *     await prisma.audit.for("Order").id(1).aggregate().atRevision(120n);
 *     await prisma.audit.for("Order").id(1).aggregate().getRevisions();
 */
export class AggregateQuery<T = Record<string, unknown>> {
  private readonly children: AggregateChild[];

  constructor(
    private readonly client: AnyClient,
    metadata: AuditMetadata,
    private readonly root: AuditModel,
    private readonly key: EntityKey,
    private readonly rootAt: (revisionId: RevisionId) => Promise<AuditRevisionEntry<T> | null>,
    relations: string[],
  ) {
    this.children = resolveChildren(metadata, root, relations);
  }

  /**
   * The aggregate as it stood at `revisionId`, or `null` when the root did not
   * exist then — the same answer `AuditQuery.atRevision` gives.
   */
  async atRevision(revisionId: RevisionId): Promise<AggregateEntry<T> | null> {
    const entry = await this.rootAt(revisionId);
    if (!entry) return null;

    const children: Record<string, Record<string, unknown>[]> = {};

    for (const child of this.children) {
      children[child.field.name] = await this.childrenAt(child, revisionId);
    }

    return { ...entry, children };
  }

  /**
   * Every revision that changed the root or one of its children, oldest first.
   *
   * A child that was moved to another root contributes only the revisions in
   * which it still belonged to this one, which is what it means for a revision
   * to have touched *this* aggregate.
   */
  async getRevisions(): Promise<AggregateRevision[]> {
    const byRevision = new Map<RevisionId, AggregateRevision["changes"]>();

    const add = (
      revisionId: RevisionId,
      change: AggregateRevision["changes"][number],
    ): void => {
      const changes = byRevision.get(revisionId) ?? [];
      changes.push(change);
      byRevision.set(revisionId, changes);
    };

    const rootRows: any[] = await this.client[this.root.auditDelegate].findMany({
      where: { ...this.key },
      select: { revisionId: true, revType: true, ...keySelect(this.root) },
    });

    for (const row of rootRows) {
      add(row.revisionId, { model: this.root.name, id: this.id(this.root, row), revType: row.revType });
    }

    for (const child of this.children) {
      const rows: any[] = await this.client[child.target.auditDelegate].findMany({
        where: this.childFilter(child),
        select: { revisionId: true, revType: true, ...keySelect(child.target) },
      });

      for (const row of rows) {
        add(row.revisionId, {
          model: child.target.name,
          relation: child.field.name,
          id: this.id(child.target, row),
          revType: row.revType,
        });
      }
    }

    return this.describe(byRevision);
  }

  /** The children that belonged to the root at `revisionId`. */
  private async childrenAt(
    child: AggregateChild,
    revisionId: RevisionId,
  ): Promise<Record<string, unknown>[]> {
    // Every child that ever belonged to this root by then. A row that has since
    // been moved away or deleted is filtered out once its state is known.
    const candidates: any[] = await this.client[child.target.auditDelegate].findMany({
      where: { ...this.childFilter(child), revisionId: { lte: revisionId } },
      select: keySelect(child.target),
      distinct: child.target.primaryKey,
    });

    const keys = candidates
      .map((row) => keyOf(child.target, row))
      .filter((key): key is EntityKey => key !== null);

    if (keys.length === 0) return [];

    const history: any[] = await this.client[child.target.auditDelegate].findMany({
      where: { ...whereAnyOf(child.target, keys), revisionId: { lte: revisionId } },
      orderBy: { revisionId: "desc" },
    });

    const latest = new Map<string, any>();

    for (const row of history) {
      const key = keyOf(child.target, row);
      if (!key) continue;

      const identity = keyIdentity(child.target, key);
      // Ordered newest first, so the first sighting of a key is its state then.
      if (!latest.has(identity)) latest.set(identity, row);
    }

    return [...latest.values()]
      .filter((row) => row.revType !== "DELETE" && this.belongsToRoot(child, row))
      .sort((a, b) => compareKeys(child.target, a, b))
      .map((row) => toEntity(child.target, row));
  }

  /** Whether the child row, as of that revision, still pointed at this root. */
  private belongsToRoot(child: AggregateChild, row: Record<string, unknown>): boolean {
    return child.link.columns.every((column) => row[column.child] === this.key[column.parent]);
  }

  /** The audit rows of a child that belong to this root. */
  private childFilter(child: AggregateChild): Record<string, unknown> {
    return Object.fromEntries(
      child.link.columns.map((column) => [column.child, this.key[column.parent]]),
    );
  }

  private id(model: AuditModel, row: Record<string, unknown>): unknown {
    const key = keyOf(model, row) ?? {};
    return model.primaryKey.length > 1 ? key : key[model.primaryKey[0] as string];
  }

  /** Attach each revision's bookkeeping to what it changed. */
  private async describe(
    byRevision: Map<RevisionId, AggregateRevision["changes"]>,
  ): Promise<AggregateRevision[]> {
    if (byRevision.size === 0) return [];

    const revisions: any[] = await this.client.revision.findMany({
      where: { id: { in: [...byRevision.keys()] } },
      orderBy: { id: "asc" },
    });

    return revisions.map((revision) => ({
      revisionId: revision.id,
      timestamp: revision.timestamp,
      user: {
        userId: revision.userId ?? null,
        username: revision.username ?? null,
      },
      changes: byRevision.get(revision.id) ?? [],
    }));
  }
}

/**
 * Order children by their key, so an aggregate reads the same way twice. The
 * order rows come back from the history is the order they were last touched in,
 * which is not an order anyone asked for.
 */
function compareKeys(
  target: AuditModel,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  for (const column of target.primaryKey) {
    const left = a[column];
    const right = b[column];

    if (left === right) continue;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;

    return left < right ? -1 : 1;
  }

  return 0;
}

/**
 * The relations to walk: the ones asked for, or every `[AuditedRelation]` when
 * none were named.
 */
function resolveChildren(
  metadata: AuditMetadata,
  root: AuditModel,
  relations: string[],
): AggregateChild[] {
  const fields =
    relations.length > 0
      ? relations.map((name) => findRelation(root, name))
      : aggregateRelations(root);

  if (fields.length === 0) {
    throw new Error(
      `${root.name} declares no [AuditedRelation], so there is no aggregate to read. ` +
        `Annotate the relation in schema.prisma, or name it: .aggregate("lines").`,
    );
  }

  return fields.map((field) => {
    const target = relationTarget(metadata, root, field);
    const link = resolveRelationLink(field, root, target);

    if (!link || link.kind !== "child-owns") {
      throw new Error(
        `${root.name}.${field.name} cannot be read as an aggregate relation: the rows on the ` +
          `other side have to point back at ${root.name} through columns the schema names.`,
      );
    }

    return { field, target, link };
  });
}

function findRelation(root: AuditModel, name: string): AuditField {
  const field = root.fields.find(
    (candidate) => candidate.name === name && candidate.kind === "relation",
  );

  if (!field) {
    throw new Error(`${root.name} has no relation called "${name}".`);
  }

  return field;
}

function relationTarget(
  metadata: AuditMetadata,
  root: AuditModel,
  field: AuditField,
): AuditModel {
  const target = metadata.models.find((candidate) => candidate.name === field.type);

  if (!target?.auditable) {
    throw new Error(
      `${root.name}.${field.name} points at ${field.type}, which is not [Auditable], ` +
        `so it has no history to read alongside ${root.name}.`,
    );
  }

  return target;
}
