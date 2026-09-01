import fs from "node:fs/promises";

import {
  PRISMA_SCALARS,
  type AuditField,
  type AuditFieldKind,
  type AuditMetadata,
  type AuditModel,
} from "../metadata.js";
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

/** Field names the generator reserves on every audit model. */
export const RESERVED_AUDIT_FIELDS = ["revisionId", "revision", "revType"];

/** Sentinel stored in `primaryKey` when the model uses `@@id([...])`. */
const COMPOSITE_KEY = " composite";

export function parseSchemaText(source: string): ParseResult {
  const lines = source.split(/\r?\n/);
  const clean: string[] = [];
  const models: AuditModel[] = [];
  const enums: string[] = [];
  const warnings: string[] = [];

  /** The annotation seen on the previous line, waiting for its declaration. */
  let pending: { name: string; line: number } | null = null;
  let currentModel: AuditModel | null = null;
  let currentBlock: string | null = null;

  const failPending = () => {
    if (pending) {
      throw new AuditSchemaError(
        `[${pending.name}] is not attached to a model or a field`,
        pending.line,
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
      failPending();
      pending = { name: standalone.name, line: lineNumber };
      // Keep the line count stable so Prisma error positions match the source.
      clean.push("");
      continue;
    }

    let line = raw;
    const trailing = matchTrailingAnnotation(raw);
    if (trailing) {
      failPending();
      pending = { name: trailing.name, line: lineNumber };
      line = trailing.rest;
    }

    const blockStart = BLOCK_START.exec(line);
    if (blockStart) {
      const kind = blockStart[1] as string;
      const name = blockStart[2] as string;

      if (kind === "enum") enums.push(name);

      if (kind === "model") {
        const auditable = pending?.name === ANNOTATIONS.auditable;
        currentModel = {
          name,
          auditable,
          auditModelName: `${name}Aud`,
          auditTableName: `${toSnakeCase(name)}_aud`,
          delegate: toDelegateName(name),
          auditDelegate: toDelegateName(`${name}Aud`),
          primaryKey: null,
          fields: [],
          line: lineNumber,
        };
        models.push(currentModel);
      } else if (pending) {
        throw new AuditSchemaError(
          `[${pending.name}] can only be placed on a model or a field, not on ${kind} ${name}`,
          pending.line,
        );
      }

      currentBlock = kind;
      pending = null;
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
      parseModelLine(currentModel, line, lineNumber, pending);
      pending = null;
    } else if (pending) {
      throw new AuditSchemaError(
        `[${pending.name}] must be followed by a model or a field declaration`,
        pending.line,
      );
    }

    clean.push(line);
  }

  failPending();

  const metadata: AuditMetadata = { version: 1, models, enums };
  resolveFieldKinds(metadata);
  validate(metadata);

  return { cleanSchema: clean.join("\n"), metadata, warnings };
}

function parseModelLine(
  model: AuditModel,
  line: string,
  lineNumber: number,
  pending: { name: string; line: number } | null,
): void {
  const trimmed = line.trim();

  // Comments, block attributes and blank lines carry no field information.
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("@@")) {
    if (pending) {
      throw new AuditSchemaError(
        `[${pending.name}] must be directly above a field declaration`,
        pending.line,
      );
    }
    if (trimmed.startsWith("@@id")) {
      // Recorded so validate() can produce a precise "composite key" error.
      model.primaryKey = COMPOSITE_KEY;
    }
    return;
  }

  const match = FIELD.exec(line);
  if (!match) {
    if (pending) {
      throw new AuditSchemaError(
        `[${pending.name}] must be directly above a field declaration`,
        pending.line,
      );
    }
    return;
  }

  const name = match[1] as string;
  const type = match[2] as string;
  const isList = Boolean(match[3]);
  const isOptional = Boolean(match[4]);
  const attributes = (match[5] ?? "").trim();

  const excludedByAnnotation = pending?.name === ANNOTATIONS.notAudited;
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

  if (isId && model.primaryKey !== COMPOSITE_KEY) model.primaryKey = name;

  model.fields.push(field);
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

function validate(metadata: AuditMetadata): void {
  for (const model of metadata.models) {
    if (!model.auditable) continue;

    if (model.primaryKey === COMPOSITE_KEY) {
      model.primaryKey = null;
      throw new AuditSchemaError(
        `Model ${model.name} uses a composite @@id, which prisma-audit does not support yet. Remove [Auditable] or give the model a single @id field`,
        model.line,
      );
    }

    if (!model.primaryKey) {
      throw new AuditSchemaError(
        `Model ${model.name} is [Auditable] but has no single-column @id field`,
        model.line,
      );
    }

    const primaryKey = model.fields.find((field) => field.name === model.primaryKey);
    if (primaryKey && !primaryKey.audited) {
      throw new AuditSchemaError(
        `The primary key ${model.name}.${primaryKey.name} cannot be [NotAudited]`,
        primaryKey.line,
      );
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

export async function parseSchemaFile(schemaPath: string): Promise<ParseResult> {
  return parseSchemaText(await fs.readFile(schemaPath, "utf8"));
}
