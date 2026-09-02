# Roadmap

The plan the project is being built against. Milestones 0–4 are done and verified
against a real PostgreSQL database; everything from M5 on is open work.

---

## M0 — Repository and tooling ✅

- pnpm workspace: `packages/prisma-audit` (published) + `examples/demo` (proving ground).
- TypeScript with `strict` and `noUncheckedIndexedAccess`, ESM throughout.
- `node --test` for unit tests, the demo for end-to-end verification.
- MIT license.

## M1 — Parser and generator ✅

The annotation layer, and the decision that makes the rest possible: `schema.prisma`
is *our* source file, preprocessed into a Prisma-ready schema.

- `[Auditable]` on a model, `[NotAudited]` on a field, both standalone and trailing.
- Annotation-only lines become blank lines, so Prisma's error line numbers still
  match the file the developer edits.
- Metadata distinguishes scalars, enums, relations and list columns. Enums are
  audited; relations and lists are skipped; the scalar foreign key is kept.
- Generated `Revision`, `RevisionType` and one `*Aud` model per audited model,
  with `@@id([revisionId, <pk>])` and `@@index([<pk>, revisionId])`.
- Errors that name the exact line: composite `@@id`, missing `@id`, `[NotAudited]`
  on a primary key, a field colliding with a generated audit column.
- `prisma-audit generate` writes `schema.prisma`, `audit.prisma` and
  `audit.metadata.json` into `prisma/.audit`, rebasing relative generator
  `output` paths so they still resolve.

## M2 — Runtime ✅

- `withAudit(client, options)` layers a query extension over the Prisma Client
  and adds `$auditTransaction` and `audit`.
- One transaction is one revision: every audited write inside `$auditTransaction`
  shares a single `Revision` row.
- A write outside `$auditTransaction` opens its own transaction, so the row and
  its audit record still commit together (`onMissingRevision`).
- `AsyncLocalStorage` carries the revision and the transaction client. Prisma
  model calls are lazy, so they are awaited *inside* the context scope — without
  that, the write executes after the scope is gone and recursively opens
  transactions until the pool is exhausted.
- `create` / `update` / `delete` are audited from the operation result, which
  Prisma returns in full, so the common path costs no extra query. A `select` or
  `omit` triggers a re-read (and a read-before-delete).
- Bulk and branching operations were left passing through at this point; M4
  closed that gap.

## M3 — AuditReader ✅

- `for(model).id(v)` with `getRevisions`, `atRevision`, `between`, `diff`.
- `atRevision` returns `null` past a `DELETE`, so "did this exist then?" is answerable.
- `revisions(n)` lists recent revisions with everything each one touched.
- Rows are split into revision bookkeeping and `entity` state rather than
  returned raw.

---

## M4 — Bulk and branching operations ✅

Every write operation Prisma exposes is now recorded. A bulk statement reports a
count rather than the rows it touched, so each one is paired with a read on the
same transaction — the documented cost is that one statement becomes two.

- `updateMany`: read the matching keys, write, read the new state back. With
  `limit` the statement is re-issued against exactly those keys, because
  otherwise the database is free to pick a different set of rows than the one
  that was read.
- `deleteMany`: read the matching rows in full first; afterwards there is
  nothing left to read.
- `createMany`: dispatched as `createManyAndReturn` where the delegate has it —
  Prisma only generates that method for databases that support it, which makes
  the delegate its own capability check. Elsewhere the insert is replayed row by
  row, honouring `skipDuplicates`. The `datasource` provider is now carried in
  `audit.metadata.json`, since SQLite has the method but rejects
  `skipDuplicates` on it.
- `createManyAndReturn` / `updateManyAndReturn`: audited from the returned rows,
  re-read when `select`/`omit` narrowed them.
- `upsert`: a key lookup before the write decides INSERT from UPDATE.
- A row touched twice in one revision keeps one audit record, holding the state
  it ended up in; created-then-changed stays an INSERT. Bulk writes make that
  overlap ordinary, and the audit table's `(revisionId, id)` key would otherwise
  reject the second write.
- Reads and audit inserts are chunked at 1000 rows, to stay under the
  bind-parameter limit on a large bulk write.
- Internal re-dispatches carry a bypass flag in the audit context, so a
  statement prisma-audit issues on the client is not audited twice.

## M5 — Schema coverage

- ✅ Composite primary keys. A model's key is a vector of columns rather than a
  scalar throughout: the parser reads `@@id([a, b])` (and the `name:` Prisma
  gives its compound argument), the audit table is keyed
  `@@id([revisionId, a, b])`, and `util/keys.ts` derives every `where` the
  runtime and the reader build from that vector. `.id({ orderId, lineNo })`
  reads the history, which is the same shape `revisions()` reports for a
  change. There is no `IN (...)` form for a multi-column key, so bulk reads
  list the keys as alternatives and are chunked by key width. Verified against
  PostgreSQL by the demo.
- ✅ Nested writes. `product.update({ data: { stock: { update: … } } })` records
  the rows it reaches as well as the top-level one. The statement itself is left
  exactly as the caller wrote it: instead of taking the payload apart and
  re-issuing it, the rows in reach — those already related to the parent, plus
  those the payload names by key — are read before and after it, and the
  difference becomes audit rows. Naming the keys is what tells a connected row
  from a created one, and a disconnected one from a deleted one; a row in reach
  that did not actually change records nothing. A write on a model that is not
  itself audited is followed too, since it can still reach one that is. The cost
  is two reads per nested relation, paid only when a nested payload is present.
  The parser now reads `@relation(fields:, references:, name:)`, which is what
  makes the rows findable; an implicit many-to-many names no join columns and
  still warns, as does an ambiguous pair of relations. Verified against
  PostgreSQL by the demo.
- Relation auditing strategies, e.g. auditing an aggregate together with its children.
- ✅ Configurable audit table naming. `[AuditTable(ProductHistory)]` names the
  generated model and derives the table from it; `[AuditTable("product_history")]`
  names the table alone, for an audit table that already exists. Annotations now
  stack on one declaration, which is what let a second one sit above a model,
  and generated names are checked against everything the schema declares —
  including the `Revision` model prisma-audit emits itself.

## M6 — Enforcement below the application

The extension only sees what goes through Prisma. A raw `UPDATE` leaves no trace.

- Generate PostgreSQL triggers alongside the audit tables, so the history holds
  regardless of who writes.
- Reconcile the two: the trigger needs the revision and the acting user, which
  means a transaction-local setting the runtime writes.
- Keep it opt-in — triggers change the migration story materially.

## M7 — Release

- CI: unit tests plus the demo against a PostgreSQL service container.
- ✅ `tsc` build validated by `npm pack` and installing the tarball into a
  scratch project: the CLI, parser, generator and runtime all resolve with
  `@prisma/client` absent.
- MySQL and SQLite verification; the generator is portable but untested there.
- ✅ Upgrade path for `audit.metadata.json`: the file is versioned, and
  `loadMetadata` upgrades an older one in memory rather than refusing to start —
  deriving what it can, leaving absent what it cannot, and failing only on a
  file newer than the build reading it. Version 1 → 2 widened `primaryKey` to a
  list of columns; 2 → 3 added how relations join.
- Publish `prisma-audit` to npm.

---

## Deliberately out of scope

- Storing diffs instead of full state. Full state makes reconstruction a single
  indexed read, and `diff()` is cheap on top of it.
- Forking the Prisma schema parser. The preprocessor sits in front of Prisma, so
  a Prisma upgrade cannot break parsing of Prisma's own syntax.
- Auditing reads. Only writes produce revisions.
