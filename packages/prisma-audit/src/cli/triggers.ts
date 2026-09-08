import fs from "node:fs/promises";
import path from "node:path";

import { generateTriggerSql } from "../generator/triggers.js";
import { tableNameOf, triggerBackedModels, type AuditMetadata, type AuditModel } from "../metadata.js";
import { parseSchemaFile } from "../parser/index.js";

export interface TriggersCommandOptions {
  /** The annotated schema the developer edits. */
  schema: string;
  /** Where to write the SQL. Absent means the caller prints it. */
  out?: string;
  /** Emit the statements that remove the triggers rather than install them. */
  drop?: boolean;
}

export interface TriggersCommandResult {
  sql: string;
  metadata: AuditMetadata;
  warnings: string[];
  /** The models the emitted SQL installs a trigger for. */
  models: AuditModel[];
  /** The file written, when `out` was given. */
  written?: string;
}

/**
 * Build the SQL that installs the audit triggers.
 *
 * The schema is parsed afresh rather than read from `audit.metadata.json`: the
 * SQL names physical tables and columns, and a metadata file left behind by an
 * older build could be describing a schema that has since been re-mapped.
 */
export async function runTriggers(
  options: TriggersCommandOptions,
): Promise<TriggersCommandResult> {
  const { metadata, warnings } = await parseSchemaFile(path.resolve(options.schema));
  const sql = generateTriggerSql(metadata, { drop: options.drop ?? false });

  const result: TriggersCommandResult = {
    sql,
    metadata,
    warnings,
    models: options.drop ? [] : triggerBackedModels(metadata),
  };

  if (options.out) {
    const target = path.resolve(options.out);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, sql, "utf8");
    result.written = target;
  }

  return result;
}

/** A one-line summary of what the SQL does, for CLI output. */
export function describeTriggers(result: TriggersCommandResult): string {
  if (result.models.length === 0) {
    return "No [AuditTriggers] models found; the SQL removes any trigger prisma-audit installed earlier.";
  }

  return result.models
    .map((model) => `  ${tableNameOf(model)} -> ${model.auditTableName}`)
    .join("\n");
}
