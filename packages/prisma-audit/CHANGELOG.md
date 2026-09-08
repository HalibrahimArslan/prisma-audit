# Changelog

## 0.1.0 — 2026-09-08

The first release. Envers-style auditing for Prisma, end to end.

### Schema

- `[Auditable]` on a model generates an audit table beside it; `[NotAudited]`
  keeps a field out of it. Annotations are stripped by `prisma-audit generate`,
  which writes a Prisma-ready schema, the audit models and `audit.metadata.json`
  into `prisma/.audit`. Annotation-only lines become blank ones, so Prisma's
  error line numbers still match the file you edit.
- `[AuditTable(...)]` names the generated model, or the table alone for a
  history table that already exists.
- `[AuditedRelation]` declares that a relation's rows belong to the model's
  aggregate.
- `[AuditTriggers]` hands a model's audit rows to a database trigger.
- Composite primary keys throughout: the audit table is keyed
  `@@id([revisionId, …])` and the reader takes the whole key.
- Errors name the line: a missing `@id`, `[NotAudited]` on a key column, a
  generated name that collides with something the schema already declares, a
  model mapped onto an audit table.

### Runtime

- `withAudit(client, options)` layers a query extension over the Prisma Client.
  One transaction is one revision; a write outside `$auditTransaction` opens a
  transaction of its own so the row and its audit record still commit together.
- Every write operation Prisma exposes is recorded, bulk and branching ones
  included. A statement that reports only a count is paired with a read.
- A nested payload is followed to the rows it reaches, without the statement
  being rewritten.
- `AuditReader`: `getRevisions`, `atRevision`, `between`, `diff`, `revisions`,
  and `aggregate()` for a root together with its children.

### Enforcement

- `prisma-audit triggers` emits idempotent, convergent PostgreSQL SQL that
  records writes the extension never sees. The runtime publishes the revision
  and the acting user on the transaction, so a write it records and a write a
  trigger records land in the same revision.
- `triggers: "suppress"` lets the migration that installs them and the build
  that relies on them go out as independent deploys.

### Databases

- Verified against PostgreSQL, MySQL and SQLite, on Prisma 7. Triggers are
  PostgreSQL only. On SQLite the revision key is an `Int`, so revision ids come
  back as numbers there.
