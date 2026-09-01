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

## Current limitations

`createMany`, `updateMany`, `deleteMany` and `upsert` are not recorded yet — they
pass through with a one-time warning. Composite primary keys are rejected at
generate time with a clear message. Nested writes are audited only for the
top-level model. List columns and relation fields are excluded from audit tables;
the scalar foreign key is kept.

---

## License

MIT. See [LICENSE](LICENSE).
