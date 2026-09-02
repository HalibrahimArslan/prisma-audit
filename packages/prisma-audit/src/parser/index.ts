import fs from "node:fs/promises";

import {
  METADATA_VERSION,
  PRISMA_SCALARS,
  type AuditField,
  type AuditRelation,
  type AuditFieldKind,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
import { splitAttributes } from "../util/attributes.js";
import { resolveRelationLink } from "../util/relations.js";
import { toDelegateName, toSnakeCase } from "../util/naming.js";
import {
  ANNOTATIONS,
  matchStandaloneAnnotation,
  matchTrailingAnnotation,
} from "./annotations.js";

export class AuditSchemaError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (schema.prisma:${line})`);
    this.name = "AuditSchemaError";
  }
}

export interface ParseResult {
  /**
   * The schema with every `[Annotation]` removed. Annotation-only lines become
   * blank lines rather than disappearing, so line numbers in Prisma's own error
   * messages still line up with the source file the developer edits.
   */
  cleanSchema: string;
  metadata: AuditMetadata;
  /** Non-fatal problems worth printing, e.g. an unrecognised annotation. */
  warnings: string[];
}

const SCALARS = new Set<string>(PRISMA_SCALARS);

const BLOCK_START =
  /^\s*(model|enum|type|view|datasource|generator)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
const FIELD =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/;
const PROVIDER = /^\s*provider\s*=\s*"([^"]+)"/;
/** `@@id([orderId, lineNo], name: "orderLine")`, with the argument list captured. */
const BLOCK_ID = /^\s*@@id\s*\(\s*\[([^\]]*)\]\s*(?:,([^)]*))?\)/;
const KEY_NAME = /\bname\s*:\s*"([^"]+)"/;
/** A Prisma model name, as `[AuditTable(...)]` may supply one. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Field names the generator reserves on every audit model. */
export const RESERVED_AUDIT_FIELDS = ["revisionId", "revision", "revType"];

export function parseSchemaText(source: string): ParseResult {
  const lines = source.split(/\r?\n/);
  const clean: string[] = [];
  const models: AuditModel[] = [];
  const enums: string[] = [];
  const warnings: string[] = [];

  /**
   * Annotations seen since the last declaration, waiting for the one they
   * belong to. A model can carry more than one, e.g. `[Auditable]` above
   * `[AuditTable(ProductHistory)]`.
   */
  let pending: PendingAnnotation[] = [];
  let currentModel: AuditModel | null = null;
  let currentBlock: string | null = null;
  /** The `datasource` provider, which decides some runtime strategies. */
  let provider: string | undefined;
  /** Where each model's `@@id([...])` sits, so key errors can point at it. */
  const keyLines = new Map<string, number>();
  /** Where each `enum` is declared, for the same reason. */
  const enumLines = new Map<string, number>();

  const failPending = () => {
    const orphan = pending[0];
    if (orphan) {
      throw new AuditSchemaError(
        `[${orphan.name}] is not attached to a model or a field`,
        orphan.line,
      );
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] as string;
    const lineNumber = index + 1;

    const standalone = matchStandaloneAnnotation(raw);
    if (standalone) {
      if (!standalone.known) {
        warnings.push(
          `schema.prisma:${lineNumber}: unknown annotation [${standalone.name}], ignored`,
        );
        clean.push("");
        continue;
      }
      pending.push({ name: standalone.name, argument: standalone.argument, line: lineNumber });
      // Keep the line count stable so Prisma error positions match the source.
      clean.push("");
      continue;
    }

    let line = raw;
    const trailing = matchTrailingAnnotation(raw);
    if (trailing) {
      pending.push({ name: trailing.name, argument: trailing.argument, line: lineNumber });
      line = trailing.rest;
    }

    const blockStart = BLOCK_START.exec(line);
    if (blockStart) {
      const kind = blockStart[1] as string;
      const name = blockStart[2] as string;

      if (kind === "enum") {
        enums.push(name);
        enumLines.set(name, lineNumber);
      }

      if (kind === "model") {
        currentModel = {
          name,
          auditable: false,
          auditModelName: `${name}Aud`,
          auditTableName: `${toSnakeCase(name)}_aud`,
          delegate: toDelegateName(name),
          auditDelegate: toDelegateName(`${name}Aud`),
          primaryKey: [],
          fields: [],
          line: lineNumber,
        };
        applyModelAnnotations(currentModel, pending);
        models.push(currentModel);
      } else {
        const first = pending[0];
        if (first) {
          throw new AuditSchemaError(
            `[${first.name}] can only be placed on a model or a field, not on ${kind} ${name}`,
            first.line,
          );
        }
      }

      currentBlock = kind;
      pending = [];
      clean.push(line);
      continue;
    }

    if (/^\s*\}\s*$/.test(line)) {
      failPending();
      currentModel = null;
      currentBlock = null;
      clean.push(line);
      continue;
    }

    if (currentBlock === "model" && currentModel) {
      parseModelLine(currentModel, line, lineNumber, pending, keyLines);
      pending = [];
    } else if (currentBlock === "datasource") {
      const match = PROVIDER.exec(line);
      if (match) provider = match[1] as string;
    } else {
      const first = pending[0];
      if (first) {
        throw new AuditSchemaError(
          `[${first.name}] must be followed by a model or a field declaration`,
          first.line,
        );
      }
    }

    clean.push(line);
  }

  failPending();

  const metadata: AuditMetadata = { version: METADATA_VERSION, models, enums };
  if (provider) metadata.provider = provider;
  resolveFieldKinds(metadata);
  validateNames(metadata, enumLines);
  validate(metadata, keyLines);

  return { cleanSchema: clean.join("\n"), metadata, warnings };
}

function parseModelLine(
  model: AuditModel,
  line: string,
  lineNumber: number,
  pending: PendingAnnotation[],
  keyLines: Map<string, number>,
): void {
  const trimmed = line.trim();
  const orphan = pending[0];

  // Comments, block attributes and blank lines carry no field information.
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("@@")) {
    if (orphan) {
      throw new AuditSchemaError(
        `[${orphan.name}] must be directly above a field declaration`,
        orphan.line,
      );
    }
    const blockId = BLOCK_ID.exec(trimmed);
    if (blockId) {
      // `@@id` wins over a field-level `@id`, which Prisma does not allow
      // alongside it anyway, and it fixes the order the key columns are in.
      model.primaryKey = keyColumns(blockId[1] as string);

      const name = KEY_NAME.exec(blockId[2] ?? "");
      if (name) model.primaryKeyName = name[1] as string;

      keyLines.set(model.name, lineNumber);
    }
    return;
  }

  const match = FIELD.exec(line);
  if (!match) {
    if (orphan) {
      throw new AuditSchemaError(
        `[${orphan.name}] must be directly above a field declaration`,
        orphan.line,
      );
    }
    return;
  }

  const name = match[1] as string;
  const type = match[2] as string;
  const isList = Boolean(match[3]);
  const isOptional = Boolean(match[4]);
  const attributes = (match[5] ?? "").trim();

  const annotations = applyFieldAnnotations(model, pending);
  const excludedByAnnotation = annotations.excluded;
  const isId = /(^|\s)@id(\s|\(|$)/.test(attributes);

  const field: AuditField = {
    name,
    type,
    kind: "scalar", // refined once every enum in the file is known
    isList,
    isOptional,
    isId,
    attributes,
    audited: !excludedByAnnotation,
    line: lineNumber,
  };

  if (excludedByAnnotation) field.excludedBy = "annotation";
  if (annotations.aggregate) field.aggregate = true;

  // A field-level `@id` only counts while no `@@id([...])` has been seen; the
  // block attribute may also come after the fields it names.
  if (isId && !keyLines.has(model.name)) model.primaryKey = [name];

  model.fields.push(field);
}

/** `[a, b]` inside an attribute argument, e.g. `fields: [categoryId]`. */
const LIST_ARGUMENT = /\b(fields|references)\s*:\s*\[([^\]]*)\]/g;
/** The relation name, written either positionally or as `name:`. */
const RELATION_NAME = /(?:^\(|\bname\s*:\s*)"([^"]+)"/;

/**
 * Read `@relation(fields: [categoryId], references: [id])` off a field.
 *
 * Only the owning side of a relation names its columns; the other side has at
 * most a relation name, and a relation with neither — an implicit many-to-many —
 * yields nothing to join on, which is exactly what the caller has to know.
 */
function parseRelation(attributes: string): AuditRelation | undefined {
  const attribute = splitAttributes(attributes).find((candidate) => candidate.name === "relation");
  if (!attribute) return undefined;

  const relation: AuditRelation = {};

  for (const [, argument, list] of attribute.text.matchAll(LIST_ARGUMENT)) {
    const columns = (list as string)
      .split(",")
      .map((column) => column.trim())
      .filter((column) => column.length > 0);

    if (argument === "fields") relation.fields = columns;
    else relation.references = columns;
  }

  const name = RELATION_NAME.exec(attribute.text.slice("@relation".length));
  if (name) relation.name = name[1] as string;

  return relation;
}

/** One `[Annotation]` waiting for the declaration it belongs to. */
interface PendingAnnotation {
  name: string;
  argument?: string;
  line: number;
}

/**
 * Apply the annotations written above a `model` declaration.
 *
 * `[Auditable]` and `[AuditTable(...)]` stack, in either order, and each may be
 * written only once.
 */
function applyModelAnnotations(model: AuditModel, pending: PendingAnnotation[]): void {
  let naming: PendingAnnotation | undefined;

  for (const annotation of pending) {
    if (annotation.name === ANNOTATIONS.notAudited) {
      throw new AuditSchemaError(
        `[${ANNOTATIONS.notAudited}] can only be placed on a field, not on model ${model.name}`,
        annotation.line,
      );
    }

    if (annotation.name === ANNOTATIONS.auditable) {
      if (model.auditable) {
        throw new AuditSchemaError(
          `Model ${model.name} carries [${ANNOTATIONS.auditable}] more than once`,
          annotation.line,
        );
      }
      model.auditable = true;
      continue;
    }

    if (naming) {
      throw new AuditSchemaError(
        `Model ${model.name} carries [${ANNOTATIONS.auditTable}] more than once`,
        annotation.line,
      );
    }
    naming = annotation;
  }

  if (naming) applyAuditTableName(model, naming);
}

/**
 * `[AuditTable(ProductHistory)]` renames the generated model, and the table
 * follows from it; `[AuditTable("product_history")]` renames the table alone,
 * which is what an existing history table needs.
 */
function applyAuditTableName(model: AuditModel, annotation: PendingAnnotation): void {
  if (!model.auditable) {
    throw new AuditSchemaError(
      `[${ANNOTATIONS.auditTable}] on model ${model.name} does nothing without [${ANNOTATIONS.auditable}]`,
      annotation.line,
    );
  }

  const argument = annotation.argument;

  if (!argument) {
    throw new AuditSchemaError(
      `[${ANNOTATIONS.auditTable}] needs a name: [${ANNOTATIONS.auditTable}(${model.name}History)] for the model, or [${ANNOTATIONS.auditTable}("${toSnakeCase(model.name)}_history")] for the table`,
      annotation.line,
    );
  }

  const quoted = /^"([^"]+)"$/.exec(argument);
  if (quoted) {
    model.auditTableName = quoted[1] as string;
    return;
  }

  if (!IDENTIFIER.test(argument)) {
    throw new AuditSchemaError(
      `[${ANNOTATIONS.auditTable}(${argument})] is neither a model name nor a quoted table name`,
      annotation.line,
    );
  }

  model.auditModelName = argument;
  model.auditTableName = toSnakeCase(argument);
  model.auditDelegate = toDelegateName(argument);
}

/** Apply the annotations written above a field. */
function applyFieldAnnotations(
  model: AuditModel,
  pending: PendingAnnotation[],
): { excluded: boolean; aggregate: boolean } {
  const applied = { excluded: false, aggregate: false };

  for (const annotation of pending) {
    if (annotation.name === ANNOTATIONS.notAudited) {
      applied.excluded = true;
    } else if (annotation.name === ANNOTATIONS.auditedRelation) {
      applied.aggregate = true;
    } else {
      throw new AuditSchemaError(
        `[${annotation.name}] can only be placed on a model, not on a field of ${model.name}`,
        annotation.line,
      );
    }
  }

  if (applied.excluded && applied.aggregate) {
    throw new AuditSchemaError(
      `A field of ${model.name} cannot be both [${ANNOTATIONS.notAudited}] and [${ANNOTATIONS.auditedRelation}]`,
      (pending[0] as PendingAnnotation).line,
    );
  }

  return applied;
}

/**
 * The column names inside `@@id([...])`, in the order they form the key.
 *
 * Prisma allows a per-column modifier — `@@id([title(length: 100), author])` —
 * which names the same column and is dropped here.
 */
function keyColumns(list: string): string[] {
  return list
    .split(",")
    .map((entry) => (entry.split("(")[0] as string).trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Enums may be declared after the models that use them, so field kinds are
 * resolved in a second pass once the whole file has been read.
 */
function resolveFieldKinds(metadata: AuditMetadata): void {
  const enums = new Set(metadata.enums);

  for (const model of metadata.models) {
    for (const field of model.fields) {
      const kind: AuditFieldKind = SCALARS.has(field.type)
        ? "scalar"
        : enums.has(field.type)
          ? "enum"
          : "relation";

      field.kind = kind;

      // Relations and list columns are out of scope for the MVP: a relation is
      // audited through the model it points at, and a list column would need a
      // history table of its own.
      if (kind === "relation") {
        const relation = parseRelation(field.attributes);
        if (relation) field.relation = relation;
      }

      if (kind === "relation" && field.audited) {
        field.audited = false;
        field.excludedBy = "relation";
      } else if (field.isList && field.audited) {
        field.audited = false;
        field.excludedBy = "list";
      }
    }
  }
}

/** Names the generator always emits, whatever the schema declares. */
const GENERATED_NAMES = new Map([
  ["Revision", "model"],
  ["RevisionType", "enum"],
]);

/**
 * Every generated name has to be free.
 *
 * Prisma keeps models and enums in one namespace, so a clash produces a schema
 * Prisma rejects with an error pointing into the generated file rather than the
 * one the developer edits. `[AuditTable(...)]` makes a clash easy to write by
 * hand, and a source model called `Revision` was always going to hit one.
 */
function validateNames(metadata: AuditMetadata, enumLines: Map<string, number>): void {
  const declared = new Map<string, number>();

  for (const model of metadata.models) declared.set(model.name, model.line);
  for (const [name, line] of enumLines) declared.set(name, line);

  for (const [name, line] of declared) {
    const kind = GENERATED_NAMES.get(name);
    if (kind) {
      throw new AuditSchemaError(
        `${name} collides with the ${kind} prisma-audit generates. Rename it`,
        line,
      );
    }
  }

  /** Audit names already taken, and the model that took them. */
  const taken = new Map<string, string>();

  for (const model of metadata.models) {
    if (!model.auditable) continue;

    if (GENERATED_NAMES.has(model.auditModelName)) {
      throw new AuditSchemaError(
        `The audit model of ${model.name} cannot be called ${model.auditModelName}: prisma-audit generates that name itself`,
        model.line,
      );
    }

    const clash = declared.get(model.auditModelName);
    if (clash !== undefined) {
      throw new AuditSchemaError(
        `The audit model of ${model.name} would be called ${model.auditModelName}, which the schema already declares on line ${clash}. Rename it with [${ANNOTATIONS.auditTable}(...)]`,
        model.line,
      );
    }

    for (const [name, kind] of [
      [model.auditModelName, "audit model"],
      [model.auditTableName, "audit table"],
    ] as const) {
      const owner = taken.get(`${kind}:${name}`);
      if (owner) {
        throw new AuditSchemaError(
          `${model.name} and ${owner} would both use the ${kind} ${name}`,
          model.line,
        );
      }
      taken.set(`${kind}:${name}`, model.name);
    }
  }
}

function validate(metadata: AuditMetadata, keyLines: Map<string, number>): void {
  for (const model of metadata.models) {
    if (!model.auditable) continue;

    const keyLine = keyLines.get(model.name) ?? model.line;

    if (model.primaryKey.length === 0) {
      throw new AuditSchemaError(
        `Model ${model.name} is [Auditable] but has no primary key. Mark a field @id, or give the model @@id([...])`,
        model.line,
      );
    }

    for (const column of model.primaryKey) {
      validateKeyColumn(model, column, keyLine);
    }

    for (const field of model.fields) {
      if (field.aggregate) validateAggregateRelation(metadata, model, field);
    }

    for (const field of model.fields) {
      if (field.audited && RESERVED_AUDIT_FIELDS.includes(field.name)) {
        throw new AuditSchemaError(
          `${model.name}.${field.name} collides with a column prisma-audit adds to every audit table (${RESERVED_AUDIT_FIELDS.join(", ")}). Rename it or mark it [NotAudited]`,
          field.line,
        );
      }
    }
  }
}

/**
 * An aggregate relation has to be one the reader can actually walk: to a model
 * that is audited, and joined by columns the schema names, with the rows on the
 * other side pointing back at this one.
 */
function validateAggregateRelation(
  metadata: AuditMetadata,
  model: AuditModel,
  field: AuditField,
): void {
  const annotation = `[${ANNOTATIONS.auditedRelation}]`;

  if (field.kind !== "relation") {
    throw new AuditSchemaError(
      `${annotation} belongs on a relation field, and ${model.name}.${field.name} is not one`,
      field.line,
    );
  }

  const target = metadata.models.find((candidate) => candidate.name === field.type);

  if (!target?.auditable) {
    throw new AuditSchemaError(
      `${model.name}.${field.name} is ${annotation}, so ${field.type} has to be [${ANNOTATIONS.auditable}] too`,
      field.line,
    );
  }

  const link = resolveRelationLink(field, model, target);

  if (!link) {
    throw new AuditSchemaError(
      `${model.name}.${field.name} is ${annotation}, but the schema does not name the columns that join it — an implicit many-to-many, or two relations that need a @relation("name") to tell them apart`,
      field.line,
    );
  }

  for (const column of link.columns) {
    const key = target.fields.find((candidate) => candidate.name === column.child);
    if (key && !key.audited) {
      throw new AuditSchemaError(
        `${model.name}.${field.name} is ${annotation}, so ${target.name}.${column.child} cannot be [${ANNOTATIONS.notAudited}]: the audit table joins on it`,
        key.line,
      );
    }
  }

  if (link.kind !== "child-owns") {
    throw new AuditSchemaError(
      `${model.name}.${field.name} is ${annotation}, but ${model.name} holds the foreign key. An aggregate root is the side the other model points at, so annotate the matching relation on ${target.name} instead`,
      field.line,
    );
  }
}

/**
 * Every key column ends up in the audit table's own `@@id([revisionId, ...])`,
 * so a key the audit table cannot hold is rejected at generate time rather than
 * producing a schema Prisma refuses.
 */
function validateKeyColumn(model: AuditModel, column: string, keyLine: number): void {
  const field = model.fields.find((candidate) => candidate.name === column);

  if (!field) {
    throw new AuditSchemaError(
      `Model ${model.name} has no field "${column}" to use as part of its primary key`,
      keyLine,
    );
  }

  if (field.audited) return;

  if (field.excludedBy === "annotation") {
    throw new AuditSchemaError(
      `The primary key ${model.name}.${field.name} cannot be [NotAudited]`,
      field.line,
    );
  }

  const reason =
    field.excludedBy === "relation"
      ? "is a relation field; put the scalar foreign key in the key instead"
      : "is a list column, which an audit table cannot key on";

  throw new AuditSchemaError(
    `${model.name}.${field.name} is part of the primary key but ${reason}`,
    field.line,
  );
}

export async function parseSchemaFile(schemaPath: string): Promise<ParseResult> {
  return parseSchemaText(await fs.readFile(schemaPath, "utf8"));
}
