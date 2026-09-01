# Roadmap

The plan the project is being built against. Milestones 0–3 are done and verified
against a real PostgreSQL database; everything from M4 on is open work.

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
- Unsupported bulk operations warn once and pass through.

## M3 — AuditReader ✅

- `for(model).id(v)` with `getRevisions`, `atRevision`, `between`, `diff`.
- `atRevision` returns `null` past a `DELETE`, so "did this exist then?" is answerable.
- `revisions(n)` lists recent revisions with everything each one touched.
- Rows are split into revision bookkeeping and `entity` state rather than
  returned raw.

---

## M4 — Bulk and branching operations

The main correctness gap. Each needs a read-before-write strategy:

- `updateMany` / `deleteMany`: select the matching rows inside the transaction
  first, then write one audit row per affected record.
- `createMany`: `createManyAndReturn` gives the rows back on PostgreSQL; the
  fallback is a per-row path.
- `upsert`: resolve to INSERT or UPDATE from whether the row existed.
- Decide and document the cost: these turn one statement into two.

## M5 — Schema coverage

- Composite primary keys — the generator, `@@id`, and every reader query assume
  a single key column today.
- Nested writes: `product.update({ data: { orderLines: { create: … } } })`
  currently audits only the top-level model.
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
- `tsup` or `tsc` build validated by publishing a tarball and installing it.
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
