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

export interface AuditField {
  /** Field name as written in `schema.prisma`. */
  name: string;
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
  /** 1-based line in the source schema, used for error messages. */
  line: number;
}

export interface AuditModel {
  /** Model name in `schema.prisma`, e.g. `Product`. */
  name: string;
  /** `true` when the model carries `[Auditable]`. */
  auditable: boolean;
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

/** The metadata format this build of prisma-audit writes and reads. */
export const METADATA_VERSION = 2;

export interface AuditMetadata {
  /**
   * Metadata format version, bumped when the shape changes. Version 2 turned
   * `AuditModel.primaryKey` from a single column name into the list of columns
   * that form the key; `loadMetadata` upgrades a version 1 file in memory.
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

/** Only the models that carry `[Auditable]`. */
export function auditableModels(metadata: AuditMetadata): AuditModel[] {
  return metadata.models.filter((model) => model.auditable);
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
