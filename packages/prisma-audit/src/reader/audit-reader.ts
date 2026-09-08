import { requireAuditableModel, type AuditMetadata, type RevisionId } from "../metadata.js";
import { isComposite, keyOf } from "../util/keys.js";
import { AuditQuery } from "./audit-query.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** A revision together with every audit row recorded under it. */
export interface RevisionSummary {
  id: RevisionId;
  timestamp: Date;
  userId: string | null;
  username: string | null;
  /**
   * What the revision did, one entry per audited row. `id` is the row's primary
   * key: the value itself for a single-column key, an object of column values
   * for a composite one — either way, what `AuditQuery.id()` takes.
   */
  changes: Array<{ model: string; revType: string; id: unknown }>;
}

/**
 * The read side of prisma-audit, the counterpart of Envers' `AuditReader`.
 *
 *     const reader = new AuditReader(prisma, metadata);
 *     await reader.for("Product").id(10).getRevisions();
 *     await reader.createQuery().forEntity("Product").id(10).atRevision(120n);
 */
export class AuditReader {
  constructor(
    private readonly client: AnyClient,
    private readonly metadata: AuditMetadata,
  ) {}

  /** Start a history query for an audited model. */
  for<T = Record<string, unknown>>(modelName: string): AuditQuery<T> {
    const model = requireAuditableModel(this.metadata, modelName);
    return new AuditQuery<T>(this.client, this.metadata, model);
  }

  /** Envers-shaped entry point: `createQuery().forEntity("Product")`. */
  createQuery(): { forEntity: <T = Record<string, unknown>>(modelName: string) => AuditQuery<T> } {
    return { forEntity: (modelName) => this.for(modelName) };
  }

  /** The most recent revisions, newest first, with what each of them touched. */
  async revisions(take = 20): Promise<RevisionSummary[]> {
    const auditable = this.metadata.models.filter((model) => model.auditable);

    const include = Object.fromEntries(
      auditable.map((model) => [model.auditDelegate, true]),
    );

    const rows = await this.client.revision.findMany({
      orderBy: { id: "desc" },
      take,
      include,
    });

    return rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.userId ?? null,
      username: row.username ?? null,
      changes: auditable.flatMap((model) =>
        (row[model.auditDelegate] ?? []).map((entry: any) => {
          const key = keyOf(model, entry) ?? {};
          return {
            model: model.name,
            revType: entry.revType,
            id: isComposite(model) ? key : key[model.primaryKey[0] as string],
          };
        }),
      ),
    }));
  }
}
