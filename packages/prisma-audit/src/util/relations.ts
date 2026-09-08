/**
 * Working out how two models are joined, which is what a nested write needs.
 *
 * A write like `product.update({ data: { stocks: { create: … } } })` reaches
 * rows of a second model, and the extension never sees an operation of its own
 * for them. To record those rows, prisma-audit first has to be able to *find*
 * them — which means knowing which columns join the two models, and in which
 * direction the foreign key points.
 */

import type { AuditField, AuditModel } from "../metadata.js";

/** One column of a join: the parent side and the child side of the same value. */
export interface JoinColumn {
  parent: string;
  child: string;
}

/**
 * How the rows on the other side of a relation are found.
 *
 * - `child-owns`: the related model holds the foreign key, so its rows are
 *   found by filtering on it — the one-to-many case, `Product.stocks`.
 * - `parent-owns`: this model holds the foreign key, so the related row is
 *   whichever one the key points at — `Product.category`.
 */
export interface RelationLink {
  kind: "child-owns" | "parent-owns";
  columns: JoinColumn[];
}

/**
 * How to reach the rows behind `field`, or `null` when the schema does not say.
 *
 * An implicit many-to-many relation names no columns on either side: the join
 * lives in a table Prisma manages and neither row's own columns change when the
 * two are connected, so there is nothing for a full-state audit to record.
 */
export function resolveRelationLink(
  field: AuditField,
  parent: AuditModel,
  target: AuditModel,
): RelationLink | null {
  const owned = joinColumns(field, "parent-owns");
  if (owned) return owned;

  const back = backRelation(field, parent, target);
  return back ? joinColumns(back, "child-owns") : null;
}

/**
 * The field on `target` that points back at `parent` through the same relation.
 *
 * Two relations between the same pair of models are told apart by the name in
 * `@relation("...")`; without one, an ambiguous pair is left unresolved rather
 * than guessed at.
 */
function backRelation(
  field: AuditField,
  parent: AuditModel,
  target: AuditModel,
): AuditField | null {
  const candidates = target.fields.filter(
    (candidate) =>
      candidate !== field && // a self-relation lists this very field as well
      candidate.kind === "relation" &&
      candidate.type === parent.name &&
      candidate.relation?.name === field.relation?.name,
  );

  return candidates.length === 1 ? (candidates[0] as AuditField) : null;
}

/** Pair up `fields` with `references`, from the side that declares them. */
function joinColumns(field: AuditField, kind: RelationLink["kind"]): RelationLink | null {
  const { fields, references } = field.relation ?? {};

  if (!fields?.length || fields.length !== references?.length) return null;

  // `fields` are always on the model the attribute is written on, and
  // `references` on the model it points at.
  const columns = fields.map((column, index) => {
    const other = references[index] as string;
    return kind === "parent-owns"
      ? { parent: column, child: other }
      : { child: column, parent: other };
  });

  return { kind, columns };
}
