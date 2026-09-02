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

- Composite primary keys — the generator, `@@id`, and every reader query assume
  a single key column today.
- Nested writes: `product.update({ data: { orderLines: { create: … } } })`
  currently audits only the top-level model. The gap is at least loud now — a
  nested write that reaches an `[Auditable]` model warns once per relation.
- Relation auditing strategies, e.g. auditing an aggregate together with its children.
- Configurable audit table naming (`[AuditTable(ProductHistory)]`).

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
- Documented upgrade path for `audit.metadata.json` version bumps.
- Publish `prisma-audit` to npm.

---

## Deliberately out of scope

- Storing diffs instead of full state. Full state makes reconstruction a single
  indexed read, and `diff()` is cheap on top of it.
- Forking the Prisma schema parser. The preprocessor sits in front of Prisma, so
  a Prisma upgrade cannot break parsing of Prisma's own syntax.
- Auditing reads. Only writes produce revisions.
