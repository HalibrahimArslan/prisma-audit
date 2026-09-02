import { splitAttributes } from "../util/attributes.js";

/**
 * Field attributes that must not be carried over onto an audit column.
 *
 * An audit table holds many rows per source row, so identity, uniqueness and
 * auto-populated values belong to the source table alone. `@map` survives
 * because it renames the column, and `@db.*` survives because it pins the
 * underlying column type — both have to match for the history to line up.
 */
const DROPPED = new Set(["id", "unique", "default", "updatedAt", "relation", "ignore"]);

/** Remove the attributes an audit column must not inherit. */
export function stripAuditAttributes(attributes: string): string {
  return splitAttributes(attributes)
    .filter((attribute) => !DROPPED.has(rootName(attribute.name)))
    .map((attribute) => attribute.text)
    .join(" ");
}

/** `db.VarChar` -> `db`, `default` -> `default`. */
function rootName(name: string): string {
  return name.split(".")[0] as string;
}
