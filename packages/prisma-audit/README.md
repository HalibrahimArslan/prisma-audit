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
prisma/schema.prisma            you edit this: [Auditable], [NotAudited]
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
revisions recorded before it existed. The key cannot be, because it is part of
`@@id([revisionId, id])`.

**Writes that bypass Prisma are not audited.** A raw `UPDATE product SET ...`
leaves no trace. Database triggers are the answer for that, and are on the
roadmap; the extension is a convenience layer, not a security boundary.

---

## Repository layout

```
packages/prisma-audit/     the published package
  src/parser/              [Auditable] / [NotAudited] -> AuditMetadata
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
prisma-audit generate [--schema prisma/schema.prisma] [--out prisma/.audit]
```

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
  onNestedWrite: (model, relation, target) => {},  // optional, replaces the warning
});
```

`onMissingRevision` decides what happens when an audited write occurs outside
`$auditTransaction`:

| value           | behaviour                                                        |
| --------------- | ---------------------------------------------------------------- |
| `"transaction"` | default — opens a transaction for that write so it is still audited |
| `"skip"`        | performs the write with no audit record                           |
| `"error"`       | refuses the write                                                 |

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

## Current limitations

Composite primary keys are rejected at generate time with a clear message.
Nested writes (`product.update({ data: { stocks: { create: … } } })`) are audited
only for the top-level model; when the nested model is `[Auditable]`, prisma-audit
warns once per relation instead of leaving a silent gap. List columns and relation
fields are excluded from audit tables; the scalar foreign key is kept. A write
that never goes through Prisma — raw SQL, another service — leaves no trace;
database triggers are on the roadmap.

---

## License

MIT. See [LICENSE](LICENSE).
