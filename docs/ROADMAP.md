# Roadmap

The plan the project is being built against. Every milestone here is done: the
package is on npm, and CI runs the unit suite, the PostgreSQL demo end to end,
and the same auditing against SQLite, MySQL and PostgreSQL on every push.

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

## M5 — Schema coverage ✅

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
- ✅ Relation auditing strategies. `[AuditedRelation]` on a relation declares
  that its rows are part of the model's aggregate, and
  `audit.for("Order").id(1).aggregate()` reads the root together with them:
  `atRevision` reconstructs the children as they stood then, `getRevisions`
  lists every revision that changed the root or a child. Nothing extra is
  stored — a child's audit row already carries the foreign key, so the
  reconstruction is a read of the latest state per child at or before the
  revision, keeping the ones that still belonged to that root. A child moved to
  another root stops belonging from the revision that moved it. The root is the
  side the children point at, and putting the annotation on the other side is a
  parse error that says so.
- ✅ Configurable audit table naming. `[AuditTable(ProductHistory)]` names the
  generated model and derives the table from it; `[AuditTable("product_history")]`
  names the table alone, for an audit table that already exists. Annotations now
  stack on one declaration, which is what let a second one sit above a model,
  and generated names are checked against everything the schema declares —
  including the `Revision` model prisma-audit emits itself.

## M6 — Enforcement below the application ✅

The extension only sees what goes through Prisma. A raw `UPDATE` left no trace.

- ✅ Generated PostgreSQL triggers. `[AuditTriggers]` on an `[Auditable]` model
  hands its audit rows to the database, and `prisma-audit triggers` emits the
  SQL: one `AFTER INSERT OR UPDATE OR DELETE` trigger per table over a function
  per audit table, plus one shared function that resolves the revision. The
  trigger transcribes the rule the runtime already applied in memory — a row
  touched twice in one revision keeps one audit record holding the state it
  ended up in, and created-then-changed stays an `INSERT`. Being SQL rather
  than Prisma, it needed the physical names, so the parser now reads `@@map`
  and `@map`, and a model mapped onto an audit table is a parse error rather
  than a history written into the table it records.
- ✅ Idempotent and convergent rather than incremental: every statement is
  `CREATE OR REPLACE` or `DROP … IF EXISTS`, and the file closes with a sweep
  driven from `pg_trigger` and `pg_proc` that removes what an earlier version
  installed and this one does not. Applying the newest file reaches the same
  state whichever one was applied last, so a schema change and its trigger
  update travel in one migration.
- ✅ Reconciled the two halves. The runtime publishes the revision and the
  acting user on the transaction with `set_config(..., true)`; a trigger that
  finds one recorded against it, and one that finds nothing opens a revision
  and publishes it back. A transaction that writes both a trigger-backed model
  and a runtime-audited one therefore produces a single revision holding both.
  For a trigger-backed model the extension stands back entirely, so a bulk
  write costs one statement rather than three.
- ✅ Opt-in, and deployable in either order. `triggers: "suppress"` has the
  runtime write every audit row itself while the triggers stand down, which is
  what lets the migration that installs them and the build that relies on them
  go out as independent deploys. Misconfiguration is caught when the client is
  built, not on the write that reaches it.
- PostgreSQL only, deliberately: MySQL triggers have no `ON CONFLICT` and
  SQLite has no transaction-local setting to carry a revision in.
- Verified against PostgreSQL by the demo, which records a `Payment` written
  through Prisma and then updated and deleted by raw SQL, and by direct psql
  checks of suppression and of a published revision being honoured.

## M7 — Release

- ✅ CI. GitHub Actions runs the unit suite on the Node version the package
  declares as its floor and on the current release, then the demo end to end
  against a PostgreSQL service container: the annotated schema preprocessed,
  the committed migrations applied with `migrate deploy` — trigger SQL and all
  — and the demo run. `pnpm verify` follows it with the same ground asserted
  rather than printed, so a regression that writes wrong audit rows without
  throwing fails the build instead of passing quietly.
- ✅ `tsc` build validated by `npm pack` and installing the tarball into a
  scratch project: the CLI, parser, generator and runtime all resolve with
  `@prisma/client` absent.
- ✅ MySQL and SQLite verification. `examples/portability` writes a datasource
  header onto one shared model file per provider, pushes the generated schema
  into an empty database, generates a client and runs the same nine checks
  through it — on SQLite, MySQL and PostgreSQL, in CI as well as locally.
  Assumed portability turned out to hide two real faults. The revision key was
  a `BigInt`, which SQLite cannot autoincrement: it gives a column that by
  making it an alias of the rowid, and only a column declared exactly `INTEGER`
  qualifies, so every insert into `revision` failed on a NOT NULL id. It is now
  an `Int` on SQLite alone, and `RevisionId` is `bigint | number` throughout.
  And `createMany` chose its strategy by asking the delegate whether it had
  `createManyAndReturn`, which the generated client answers yes to on every
  database and only refuses once the call has been made; the provider decides
  now, and an unknown one replays the insert row by row, which is correct
  everywhere.
- ✅ Upgrade path for `audit.metadata.json`: the file is versioned, and
  `loadMetadata` upgrades an older one in memory rather than refusing to start —
  deriving what it can, leaving absent what it cannot, and failing only on a
  file newer than the build reading it. Version 1 → 2 widened `primaryKey` to a
  list of columns; 2 → 3 added how relations join.
- ✅ Published to npm as `prisma-audit@0.1.0`, tagged `v0.1.0`. Installing it
  from the registry into an empty project resolves the CLI and all forty
  exports with `@prisma/client` absent.

---

## Deliberately out of scope

- Storing diffs instead of full state. Full state makes reconstruction a single
  indexed read, and `diff()` is cheap on top of it.
- Forking the Prisma schema parser. The preprocessor sits in front of Prisma, so
  a Prisma upgrade cannot break parsing of Prisma's own syntax.
- Auditing reads. Only writes produce revisions.
