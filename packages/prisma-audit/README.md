# prisma-audit

Hibernate Envers-style auditing for Prisma. Annotate a model, and every
`create` / `update` / `delete` is recorded in a generated history table under a
central `Revision`, readable through an `AuditReader`.

```prisma
[Auditable]
model Product {
  id       Int      @id @default(autoincrement())
  name     String
  price    Decimal  @db.Decimal(12, 2)
  currency Currency @default(TRY)

  [NotAudited]
  internalCode String?
}
```

```ts
await prisma.$auditTransaction({ userId: "42", username: "halil" }, async (tx) => {
  await tx.product.update({ where: { id: 1 }, data: { price: 55_000 } });
  await tx.stock.update({ where: { productId: 1 }, data: { quantity: 3 } });
});

await prisma.audit.for("Product").id(1).getRevisions();
await prisma.audit.for("Product").id(1).atRevision(120n);
await prisma.audit.for("Product").id(1).diff(100n, 120n);
```

Status: **working end to end** against PostgreSQL and Prisma 7. See
[docs/ROADMAP.md](docs/ROADMAP.md) for what is done and what is next.

---

## Install

Not on npm yet, so install it from a tarball built out of this repository:

```bash
pnpm install && pnpm build
cd packages/prisma-audit && npm pack        # -> prisma-audit-0.1.0.tgz
```

```bash
# in your own project
npm install /path/to/prisma-audit-0.1.0.tgz
```

That gives you both the `prisma-audit` CLI and the runtime. `@prisma/client` is
an optional peer dependency: the parser, generator and CLI need nothing but
Node 20+, and `withAudit()` wraps the client your project already has.

---

## How it works

`schema.prisma` is the file you edit, and it is *not* handed to the Prisma CLI —
it carries annotations Prisma does not understand. `prisma-audit generate`
preprocesses it:

```
prisma/schema.prisma            you edit this: [Auditable], [NotAudited], [AuditTable],
        │                                      [AuditedRelation], [AuditTriggers]
        │
        ▼
   prisma-audit generate
        │
        ├── prisma/.audit/schema.prisma        annotations stripped
        ├── prisma/.audit/audit.prisma         Revision + *Aud models
        └── prisma/.audit/audit.metadata.json  consumed by the runtime
        │
        ▼
   prisma migrate dev / prisma generate       reads prisma/.audit as one schema
```

At runtime, `withAudit()` wraps the Prisma Client with an extension that
intercepts writes to annotated models:

```
prisma.product.update()
        │
        ▼
  audit extension ──── one transaction ────┐
        │                                  │
        ├── UPDATE "Product"               │
        ├── INSERT "revision"              │
        └── INSERT "product_aud"           │
                                    commit ┘
```

### Design decisions worth knowing

**One transaction is one revision.** A `$auditTransaction` that touches three
models produces one `Revision` row and three audit rows, so a unit of work reads
as a single event in the history. This is why `Revision` has no operation
column — the operation (`INSERT` / `UPDATE` / `DELETE`) lives on each audit row.

**Full state, not diffs.** Each audit row stores the complete state of the row
at that revision, the way Envers does. Reconstructing any past version is then a
single indexed lookup, and `diff()` is computed on read.

**The primary key stays required, everything else is optional.** Audit columns
are nullable so that a column added to the model later does not invalidate
revisions recorded before it existed. The key columns cannot be, because they
are part of `@@id([revisionId, …])`.

**The extension is a convenience layer, not a boundary.** It sees what goes
through Prisma, so a raw `UPDATE product SET ...` leaves no trace. Where the
history has to hold whatever writes the table, `[AuditTriggers]` moves the
recording into the database itself — see
[Enforcement below the application](#enforcement-below-the-application).

---

## Repository layout

```
packages/prisma-audit/     the published package
  src/parser/              the [Annotation] vocabulary -> AuditMetadata
  src/generator/           AuditMetadata -> audit.prisma
  src/runtime/             withAudit, $auditTransaction, the query extension
  src/reader/              AuditReader / AuditQuery
  src/cli/                 prisma-audit generate
examples/demo/             a runnable PostgreSQL walkthrough
docs/ROADMAP.md            milestones, done and planned
```

---

## Try the demo

Requires Docker and Node 20+.

```bash
pnpm install
pnpm build

cd examples/demo
pnpm db:up            # PostgreSQL on port 55432
pnpm audit:generate   # schema.prisma -> prisma/.audit
pnpm migrate          # creates Product, Stock, revision, product_aud, stock_aud
pnpm demo
```

It prints a product's full history, time-travels to an earlier revision, diffs
two revisions, shows that a deleted row keeps its history, and shows that a
`[NotAudited]` column never reaches the audit table.

---

## API

### Generate

```bash
prisma-audit generate [--schema prisma/schema.prisma] [--out prisma/.audit] [--triggers]
prisma-audit triggers [--schema prisma/schema.prisma] [--out file.sql] [--drop]
```

`generate` writes the Prisma-ready schema and the metadata; `--triggers` treats
every `[Auditable]` model as `[AuditTriggers]` as well, for a schema where the
whole history is enforced in the database. `triggers` writes the SQL that
installs them, to stdout unless `--out` names a file — see
[Enforcement below the application](#enforcement-below-the-application).

Point Prisma at the output directory, in `prisma.config.ts`:

```ts
export default defineConfig({
  schema: "prisma/.audit",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
```

Commit `prisma/schema.prisma` and `prisma/migrations`; git-ignore `prisma/.audit`.

### Runtime

```ts
import { loadMetadata, withAudit } from "prisma-audit";

export const prisma = withAudit(new PrismaClient({ adapter }), {
  metadata: loadMetadata("prisma/.audit/audit.metadata.json"),
  userProvider: () => currentRequestUser(),   // optional
  onMissingRevision: "transaction",           // "transaction" | "skip" | "error"
  onNestedWrite: (model, relation, target) => {},  // optional, see Nested writes
  triggers: "auto",                           // "auto" | "suppress" | "off"
});
```

`onMissingRevision` decides what happens when an audited write occurs outside
`$auditTransaction`:

| value           | behaviour                                                        |
| --------------- | ---------------------------------------------------------------- |
| `"transaction"` | default — opens a transaction for that write so it is still audited |
| `"skip"`        | performs the write with no audit record                           |
| `"error"`       | refuses the write                                                 |

It governs the runtime's own recording only. A trigger-backed model is recorded
by the database whatever this says — `"skip"` on such a write means the trigger
opens the revision itself, and it carries no user.

### Read

```ts
prisma.audit.for("Product").id(10).getRevisions();      // full history, oldest first
prisma.audit.for("Product").id(10).atRevision(120n);    // state at a revision, null if deleted
prisma.audit.for("Product").id(10).between(100n, 150n);
prisma.audit.for("Product").id(10).diff(100n, 150n);
prisma.audit.revisions(20);                             // recent revisions and what they touched

// Envers-shaped alternative
prisma.audit.createQuery().forEntity("Product").id(10).getRevisions();
```

---

## Bulk and branching writes

`createMany`, `updateMany`, `deleteMany` and `upsert` report a row count, not the
rows they touched, so each one is paired with a read inside the same transaction.
That is the cost, stated plainly: one statement becomes two.

| operation                                    | strategy                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `updateMany`                                 | read the matching keys, write, then read the new state back                    |
| `deleteMany`                                 | read the matching rows in full first — after the delete there is nothing to read |
| `createMany`                                 | run it as `createManyAndReturn` where the database has it, else insert row by row |
| `createManyAndReturn` / `updateManyAndReturn` | audited from the rows the statement returns                                    |
| `upsert`                                     | a key lookup before the write decides between an INSERT and an UPDATE revision |

Rows are read back, and audit rows written, in batches of 1000, so a bulk write
over a large table does not run into the database's bind-parameter limit.

A row touched more than once in one revision keeps a single audit record — the
audit table is keyed `(revisionId, id)` — holding the state the row ended up in.
A row created and then changed within the same revision stays an `INSERT`.

With `limit`, the database chooses which of the matching rows to touch, so
prisma-audit re-issues the statement against exactly the keys it read. Without
`limit` the caller's filter is used as written: a row another transaction inserts
between the read and the write would be changed without an audit row. Raise the
isolation level if that matters.

---

## Annotations

Five of them, written in square brackets above the declaration they apply to.
`prisma-audit generate` strips them out, so `schema.prisma` stays a file you own
and Prisma never sees the annotations.

| annotation           | on                     | effect                                        |
| -------------------- | ---------------------- | --------------------------------------------- |
| `[Auditable]`        | a model                | the model gets an audit table                 |
| `[NotAudited]`       | a field                | the field is left out of the audit table      |
| `[AuditTable(...)]`  | an `[Auditable]` model | names that audit table                        |
| `[AuditedRelation]`  | a relation field       | its rows are part of this model's aggregate   |
| `[AuditTriggers]`    | an `[Auditable]` model | the database records it, not the runtime      |

By default the history of `Product` is the model `ProductAud`, mapped to the
table `product_aud`. `[AuditTable]` overrides that, in either of two ways:

```prisma
[Auditable]
[AuditTable(ProductHistory)]    // model ProductHistory, table product_history
model Product { … }

[Auditable]
[AuditTable("stock_history")]   // model StockAud, table stock_history
model Stock { … }
```

An identifier names the generated model and the table name follows from it; a
quoted string names the table alone, which is what an existing history table
needs. Neither changes how the history is read — the reader is asked for
`"Product"`, the model as your schema names it.

Generated names are checked while parsing: one that collides with a model the
schema already declares, with another model's audit table, or with the
`Revision` model prisma-audit generates itself, is an error naming both sides.

## Composite primary keys

A model keyed on more than one column is audited like any other; the audit table
simply carries every key column, and the whole key is what identifies a row.

```prisma
[Auditable]
model OrderLine {
  orderId  Int
  lineNo   Int
  quantity Int

  @@id([orderId, lineNo])
}
```

```prisma
// generated
model OrderLineAud {
  revisionId BigInt
  revType    RevisionType

  orderId  Int
  lineNo   Int
  quantity Int?

  @@id([revisionId, orderId, lineNo])
  @@index([orderId, lineNo, revisionId])
}
```

The reader takes the key as an object:

```ts
await prisma.audit.for("OrderLine").id({ orderId: 1, lineNo: 2 }).getRevisions();
```

which is exactly the shape `revisions()` reports for a change, so a summary can
be handed straight back:

```ts
for (const change of (await prisma.audit.revisions()).flatMap((r) => r.changes)) {
  await prisma.audit.for(change.model).id(change.id).getRevisions();
}
```

A single-column key still reads as the value itself — `.id(10)` — and reports as
`change.id === 10`.

Bulk writes cost slightly more on a composite key: there is no `IN (...)` form
for a multi-column key, so the rows are read back as a list of alternatives
(`WHERE (orderId, lineNo) = … OR …`), which the primary key index still serves.

---

## Nested writes

A write can reach a second model inside a single Prisma call:

```ts
await prisma.product.update({
  where: { id: 1 },
  data: {
    price: 58_000,
    stock: { update: { quantity: 2 } },   // a different model, same statement
  },
});
```

Prisma resolves the whole payload itself, so no separate operation reaches the
extension for the `Stock` row. Rather than take the payload apart and re-issue
it — which would mean prisma-audit rewriting your query, and guessing at foreign
keys, `connectOrCreate` and implicit many-to-many — the statement is left
exactly as written and the rows it can reach are read before and after it:

| after the write | recorded |
| --------------- | -------- |
| a key that was not in reach before | `INSERT` |
| a key on both sides, with a changed column | `UPDATE` |
| a key that is gone | `DELETE` |
| a key on both sides, unchanged | nothing |

"In reach" is every row already related to the parent, plus every row the
payload names by key — `connect`, `set`, `disconnect`, `update`, `delete`,
`upsert`. That is what makes a connected row recognisable as the update it is
rather than an insert, and a disconnected one as an update rather than a delete.
Everything lands under the parent's revision, so the whole call still reads as
one event.

The cost is two extra reads per nested relation, paid only by a write that
carries a nested payload.

Two relations cannot be followed this way, and each warns once instead:
an implicit many-to-many, where neither side names a join column and neither
row's own columns change, and two relations between the same models with no
`@relation("name")` to tell them apart. Pass `onNestedWrite` to `withAudit` to
handle those yourself instead of warning.

## Enforcement below the application

The query extension records what goes through Prisma. `[AuditTriggers]` records
what goes through the *database*: a raw `UPDATE`, another service, a psql
session, a cascade.

```prisma
[Auditable]
[AuditTriggers]
model Payment {
  id      Int     @id @default(autoincrement())
  orderId Int     @map("order_id")
  amount  Decimal @db.Decimal(12, 2)
  status  String

  @@map("payment")
}
```

The audit table is the same one, and so is the reader —
`prisma.audit.for("Payment").id(1).getRevisions()` does not care which half
wrote the rows. What changes is who writes them: for a trigger-backed model the
runtime stands back, issuing the statement exactly as you wrote it. A bulk write
costs one statement rather than the three auditing it in the runtime needs.

PostgreSQL only. MySQL triggers have no `ON CONFLICT`, and SQLite has no
transaction-local setting to carry a revision in, so each would be a different
design rather than this one ported.

### Installing them

Triggers are ordinary SQL in an ordinary migration: Prisma migrate neither
generates them nor sees them drift.

```bash
prisma migrate dev --create-only --name audit_triggers
prisma-audit triggers >> prisma/migrations/<timestamp>_audit_triggers/migration.sql
prisma migrate dev
```

The file is idempotent and convergent — every statement is `CREATE OR REPLACE`
or `DROP … IF EXISTS`, and it closes with a sweep that removes whatever an
earlier version installed and this one does not. Re-running the newest file
therefore reaches the same state whichever one was applied last, so a schema
change and its trigger update can travel in one migration.

### How a revision reaches the trigger

A trigger cannot see your call stack, so the runtime publishes the revision and
the acting user on the transaction with `set_config(..., true)`, which reverts
when the transaction ends. A trigger that finds one published records against
it; one that finds nothing — a write that never went through the application —
opens a revision of its own and publishes it back, so every later statement of
that transaction shares it. One unit of work is one revision either way, and a
transaction that writes both a trigger-backed model and a runtime-audited one
produces a single revision holding both changes.

A write from outside the application has no user to record, so its revision
carries none.

### Deploying them

`triggers` in the runtime options says how the two halves divide the work:

| value        | behaviour                                                              |
| ------------ | ---------------------------------------------------------------------- |
| `"auto"`     | default — the metadata decides, model by model; costs nothing when no model is trigger-backed |
| `"suppress"` | the runtime writes every audit row itself and the triggers stand down   |
| `"off"`      | the runtime writes every audit row itself and publishes nothing         |

`"suppress"` is what makes the migration and the build independent, in either
order and without a write being recorded twice:

1. deploy the current build with `triggers: "suppress"` — a no-op while no
   trigger exists;
2. apply the migration that installs them; they stand down on sight of the
   setting, and the runtime keeps recording as before;
3. deploy the build generated from the `[AuditTriggers]` schema, with
   `triggers` back to `"auto"`.

Rolling back is the same list read upwards. `"off"` is the escape hatch for a
database whose triggers were dropped before the metadata caught up.

## Current limitations

Nested writes are followed one level deep: a payload nested inside a nested
payload is not. List columns and relation fields are excluded from audit tables;
the scalar foreign key is kept. A write that never goes through Prisma — raw
SQL, another service — is recorded only for a model that carries
`[AuditTriggers]`, and that is PostgreSQL only.

---

## License

MIT. See [LICENSE](LICENSE).
