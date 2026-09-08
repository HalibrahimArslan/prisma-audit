/**
 * The metadata contract that the parser produces and every other layer
 * (generator, runtime extension, AuditReader) consumes.
 *
 * It is deliberately a plain, JSON-serialisable structure: `prisma-audit generate`
 * writes it to disk as `audit.metadata.json` so that the runtime never has to
 * re-parse `schema.prisma` at application start-up.
 */

/** Prisma scalar types that can be copied verbatim into an audit table. */
export const PRISMA_SCALARS = [
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
] as const;

export type PrismaScalar = (typeof PRISMA_SCALARS)[number];

export type AuditFieldKind = "scalar" | "enum" | "relation" | "unsupported";

/**
 * How a relation field is joined, as `@relation(...)` writes it.
 *
 * Only the owning side of a relation carries `fields`/`references`; the other
 * side carries the relation name at most. prisma-audit needs both to find the
 * rows a nested write reaches.
 */
export interface AuditRelation {
  /** The scalar columns on this model that hold the foreign key. */
  fields?: string[];
  /** The columns those point at, on the related model. */
  references?: string[];
  /** The `@relation("name")`, which tells two relations to one model apart. */
  name?: string;
}

export interface AuditField {
  /** Field name as written in `schema.prisma`. */
  name: string;
  /**
   * The column the field is stored in: `@map("...")`, or the field name, which
   * is what Prisma falls back to. Prisma hides the difference, but a trigger is
   * written against the name the database actually has.
   */
  columnName?: string;
  /** Prisma type name, without the `?` / `[]` modifiers. */
  type: string;
  kind: AuditFieldKind;
  /** `true` when the field is declared as a list (`String[]`). */
  isList: boolean;
  /** `true` when the field is declared optional (`String?`). */
  isOptional: boolean;
  /** `true` when the field carries `@id`. */
  isId: boolean;
  /** Attributes as written, e.g. `@id @default(autoincrement())`. */
  attributes: string;
  /**
   * `false` when the field carries `[NotAudited]`, or when it cannot be
   * audited at all (relations and list fields are skipped in the MVP).
   */
  audited: boolean;
  /** Why an otherwise normal field ended up with `audited: false`. */
  excludedBy?: "annotation" | "relation" | "list";
  /** How the relation is joined. Only present when `kind` is `"relation"`. */
  relation?: AuditRelation;
  /**
   * `true` when the field carries `[AuditedRelation]`: the rows it points at
   * belong to this model's aggregate, and the reader can reconstruct them
   * alongside it.
   */
  aggregate?: boolean;
  /** 1-based line in the source schema, used for error messages. */
  line: number;
}

export interface AuditModel {
  /** Model name in `schema.prisma`, e.g. `Product`. */
  name: string;
  /**
   * The table the model is stored in: `@@map("...")`, or the model name, which
   * is what Prisma falls back to — verbatim, so in PostgreSQL it is the
   * case-sensitive `"Product"` rather than `product`.
   */
  tableName?: string;
  /** `true` when the model carries `[Auditable]`. */
  auditable: boolean;
  /**
   * `true` when the model carries `[AuditTriggers]`: its audit rows are written
   * by a database trigger rather than by the runtime, so the history holds for
   * a write that never went through Prisma.
   */
  triggers?: boolean;
  /** Generated audit model name, e.g. `ProductAud`. */
  auditModelName: string;
  /** Table name the audit model maps to, e.g. `product_aud`. */
  auditTableName: string;
  /** Prisma Client delegate for the source model, e.g. `product`. */
  delegate: string;
  /** Prisma Client delegate for the audit model, e.g. `productAud`. */
  auditDelegate: string;
  /**
   * The columns that form the primary key, in key order: one entry for a field
   * marked `@id`, several for `@@id([a, b])`, and none when the model has no
   * primary key at all.
   */
  primaryKey: string[];
  /**
   * The name Prisma Client gives the compound key argument of a composite key,
   * i.e. the `name:` of `@@id([a, b], name: "...")`. Absent when the key is a
   * single column, or when Prisma's default name (`a_b`) applies.
   */
  primaryKeyName?: string;
  fields: AuditField[];
  line: number;
}

/**
 * A revision's identifier, as the database hands it back.
 *
 * `bigint` on every provider but SQLite, where the revision key has to be an
 * `Int` for SQLite to autoincrement it at all, and the client therefore returns
 * a number. Both are only ever compared with each other or passed back into a
 * query, so the runtime and the reader take either rather than converting and
 * leaving two spellings of the same revision in circulation.
 */
export type RevisionId = bigint | number;

/** The metadata format this build of prisma-audit writes and reads. */
export const METADATA_VERSION = 5;

export interface AuditMetadata {
  /**
   * Metadata format version, bumped when the shape changes. Version 2 turned
   * `AuditModel.primaryKey` from a single column name into the list of columns
   * that form the key; version 3 added `AuditField.relation`, which is what
   * lets a nested write be followed to the rows it reaches; version 4 added
   * `AuditField.aggregate`; version 5 added the physical names a trigger is
   * written against — `AuditModel.tableName`, `AuditField.columnName` — and
   * `AuditModel.triggers`. `loadMetadata` upgrades an older file in memory as
   * far as it can.
   */
  version: number;
  /** Every model found in the schema, audited or not. */
  models: AuditModel[];
  /** Enum names declared in the schema; used to tell enums from relations. */
  enums: string[];
  /**
   * The `datasource` provider, e.g. `postgresql`. Optional because metadata
   * written before this field existed does not carry it; the runtime treats an
   * absent provider as "assume the least capable database".
   */
  provider?: string;
}

/** The audited fields of a model, in schema order. */
export function auditedFields(model: AuditModel): AuditField[] {
  return model.fields.filter((field) => field.audited);
}

/** The relations declared `[AuditedRelation]`, i.e. this model's aggregate. */
export function aggregateRelations(model: AuditModel): AuditField[] {
  return model.fields.filter((field) => field.aggregate);
}

/** Only the models that carry `[Auditable]`. */
export function auditableModels(metadata: AuditMetadata): AuditModel[] {
  return metadata.models.filter((model) => model.auditable);
}

/**
 * The table a model is stored in.
 *
 * Metadata written before version 5 carries no physical names, because the
 * parser did not read `@@map` then — so falling back to Prisma's own default is
 * exactly right for the schemas that file could describe.
 */
export function tableNameOf(model: AuditModel): string {
  return model.tableName ?? model.name;
}

/** The column a field is stored in. Same fallback as `tableNameOf`. */
export function columnNameOf(field: AuditField): string {
  return field.columnName ?? field.name;
}

/**
 * The models whose audit rows a database trigger writes.
 *
 * Absent means off, which is the safe direction: metadata that predates
 * triggers, or that is merely stale, leaves the runtime writing the rows itself
 * rather than quietly recording nothing.
 */
export function triggerBackedModels(metadata: AuditMetadata): AuditModel[] {
  return metadata.models.filter((model) => model.auditable && model.triggers === true);
}

/** Look up an auditable model by its schema name, or throw a helpful error. */
export function requireAuditableModel(
  metadata: AuditMetadata,
  modelName: string,
): AuditModel {
  const model = metadata.models.find((candidate) => candidate.name === modelName);

  if (!model) {
    const known = metadata.models.map((candidate) => candidate.name).join(", ");
    throw new Error(
      `Unknown model "${modelName}". Models in the schema: ${known || "(none)"}`,
    );
  }

  if (!model.auditable) {
    throw new Error(
      `Model "${modelName}" is not auditable. Add [Auditable] above it in schema.prisma and re-run "prisma-audit generate".`,
    );
  }

  return model;
}
