/**
 * prisma-audit — Hibernate Envers style auditing for Prisma.
 *
 * Three layers, each usable on its own:
 *
 *   parser + generator  `[Auditable]` / `[NotAudited]` in schema.prisma become
 *                       `Revision` and `*Aud` models.
 *   runtime             `withAudit()` records create/update/delete, one
 *                       revision per transaction.
 *   reader              `AuditReader` walks the history back.
 */

export {
  PRISMA_SCALARS,
  auditableModels,
  auditedFields,
  requireAuditableModel,
  type AuditField,
  type AuditFieldKind,
  type AuditMetadata,
  type AuditModel,
  type PrismaScalar,
} from "./metadata.js";

export {
  AuditSchemaError,
  RESERVED_AUDIT_FIELDS,
  parseSchemaFile,
  parseSchemaText,
  type ParseResult,
} from "./parser/index.js";

export { ANNOTATIONS, type AnnotationName } from "./parser/annotations.js";

export { generateAuditSchema, type GenerateOptions } from "./generator/index.js";
export { rebaseRelativePaths } from "./generator/rebase.js";

export {
  getAuditContext,
  hasOpenRevision,
  runWithAuditContext,
  type AuditContext,
  type AuditUser,
} from "./runtime/context.js";

export {
  type AuditOptions,
  type MissingRevisionPolicy,
  type PrismaClientLike,
} from "./runtime/extension.js";

export {
  withAudit,
  type AuditablePrismaClient,
  type AuditableClientExtras,
  type AuditTransactionOptions,
} from "./runtime/with-audit.js";

export { AuditReader, type RevisionSummary } from "./reader/audit-reader.js";
export {
  AuditQuery,
  type AuditRevisionEntry,
  type EntityDiff,
  type FieldChange,
  type RevisionType,
} from "./reader/audit-query.js";

export { loadMetadata } from "./util/load-metadata.js";
export { toDelegateName, toSnakeCase } from "./util/naming.js";

export {
  describeResult,
  runGenerate,
  type GenerateCommandOptions,
  type GenerateCommandResult,
} from "./cli/generate.js";
