/**
 * End-to-end walk through prisma-audit against a real PostgreSQL database.
 *
 *   pnpm db:up && pnpm audit:generate && pnpm migrate && pnpm demo
 */
import { prisma, setCurrentUser } from "./prisma.js";

const halil = { userId: "42", username: "halil" };
const ahmet = { userId: "55", username: "ahmet" };

async function main(): Promise<void> {
  await reset();

  const category = await prisma.category.create({ data: { name: "Phones" } });

  // ── 1. One transaction, one revision, two models ───────────────────────────
  // Both writes land under a single Revision, the way Envers records a unit of
  // work. `tx` is a normal Prisma client; nothing about the call sites changes.
  const product = await prisma.$auditTransaction(halil, async (tx) => {
    const created = await tx.product.create({
      data: {
        name: "iPhone",
        price: 50_000,
        categoryId: category.id,
        internalCode: "SECRET-1",
      },
    });

    await tx.stock.create({ data: { productId: created.id, quantity: 10 } });

    return created;
  });

  // ── 2. An update by a different user ──────────────────────────────────────
  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.product.update({
      where: { id: product.id },
      data: { price: 55_000, currency: "USD" },
    });
  });

  // ── 3. A write with no explicit transaction ───────────────────────────────
  // `userProvider` supplies the user and prisma-audit opens a revision of its
  // own, so the row and its audit record still commit together.
  setCurrentUser(halil);
  await prisma.product.update({
    where: { id: product.id },
    data: { name: "iPhone 15" },
  });

  // ── 4. A delete: the row goes, the history stays ──────────────────────────
  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.stock.delete({ where: { productId: product.id } });
  });

  // ── 5. Category is not [Auditable], so this leaves no trace ───────────────
  await prisma.category.update({
    where: { id: category.id },
    data: { name: "Mobile Phones" },
  });

  await report(product.id);
  await bulk(category.id);
  await composite();
}

/**
 * Bulk and branching writes. Each one reports a row count rather than the rows
 * it touched, so prisma-audit pairs it with a read on the same transaction and
 * records one audit row per affected record.
 */
async function bulk(categoryId: number): Promise<void> {
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.createMany({
      data: [
        { name: "Pixel", price: 30_000, categoryId },
        { name: "Galaxy", price: 40_000, categoryId },
      ],
    });
  });

  // One statement, two rows, two audit records — all under a single revision.
  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.product.updateMany({
      where: { name: { in: ["Pixel", "Galaxy"] } },
      data: { price: 45_000 },
    });
  });

  // upsert branches inside the database; the revision type follows.
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.upsert({
      where: { id: 999 },
      create: { id: 999, name: "Nothing Phone", price: 20_000, categoryId },
      update: { price: 21_000 },
    });
    await tx.product.upsert({
      where: { id: 999 },
      create: { id: 999, name: "Nothing Phone", price: 20_000, categoryId },
      update: { price: 21_000 },
    });
  });

  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.product.deleteMany({ where: { name: "Galaxy" } });
  });

  console.log("\n── Bulk writes ─────────────────────────────────────────────");
  for (const revision of (await prisma.audit.revisions(4)).reverse()) {
    const changes = revision.changes
      .map((change) => `${change.model}#${formatKey(change.id)} ${change.revType}`)
      .join(", ");
    console.log(`  rev ${String(revision.id).padStart(3)}  ${revision.username ?? "-"}  ${changes}`);
  }

  // The second upsert of the same row in one revision updated the record the
  // first one wrote, and the revision stayed an INSERT: that is what it did.
  const nothingPhone = await prisma.audit.for("Product").id(999).getRevisions();
  console.log("\n── upsert twice in one revision ────────────────────────────");
  for (const entry of nothingPhone) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}  price=${String(entity.price)}`,
    );
  }
}

/**
 * A model whose primary key spans two columns. Nothing about the call sites
 * changes; the audit table is keyed on `(revisionId, orderId, lineNo)` and the
 * reader is given the whole key.
 */
async function composite(): Promise<void> {
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.orderLine.createMany({
      data: [
        { orderId: 1, lineNo: 1, quantity: 2 },
        { orderId: 1, lineNo: 2, quantity: 5 },
        { orderId: 2, lineNo: 1, quantity: 1 },
      ],
    });
  });

  // A bulk write over one order: two of the three rows, each audited under its
  // own two-column key.
  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.orderLine.updateMany({ where: { orderId: 1 }, data: { quantity: 9 } });
  });

  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.orderLine.update({
      where: { orderId_lineNo: { orderId: 1, lineNo: 2 } },
      data: { note: "gift wrap" },
    });
  });

  const history = await prisma.audit
    .for("OrderLine")
    .id({ orderId: 1, lineNo: 2 })
    .getRevisions();

  console.log("\n── Composite key: history of order 1, line 2 ───────────────");
  for (const entry of history) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}` +
        `  by ${(entry.user.username ?? "-").padEnd(6)}` +
        `  quantity=${String(entity.quantity)} note=${String(entity.note)}`,
    );
  }

  console.log("\n── Composite key: what each revision touched ───────────────");
  for (const revision of (await prisma.audit.revisions(3)).reverse()) {
    const changes = revision.changes
      .map((change) => `${change.model}(${formatKey(change.id)}) ${change.revType}`)
      .join(", ");
    console.log(`  rev ${String(revision.id).padStart(3)}  ${revision.username ?? "-"}  ${changes}`);
  }
}

/** A change reports its key as the value itself, or as a column-per-value object. */
function formatKey(id: unknown): string {
  if (id === null || typeof id !== "object") return String(id);

  return Object.entries(id)
    .map(([column, value]) => `${column}=${String(value)}`)
    .join(", ");
}

async function report(productId: number): Promise<void> {
  const history = await prisma.audit.for("Product").id(productId).getRevisions();

  console.log("\n── Product history ─────────────────────────────────────────");
  for (const entry of history) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}` +
        `  by ${(entry.user.username ?? "-").padEnd(6)}` +
        `  name=${String(entity.name).padEnd(10)} price=${String(entity.price)} ${String(entity.currency)}`,
    );
  }

  // `internalCode` is [NotAudited]: it must never reach the audit table.
  const leaked = history.some((entry) => "internalCode" in (entry.entity as object));
  console.log(`\n  [NotAudited] internalCode present in history: ${leaked}`);

  const first = history[0]?.revisionId;
  const last = history.at(-1)?.revisionId;

  if (first !== undefined && last !== undefined) {
    console.log("\n── Time travel ─────────────────────────────────────────────");
    const atFirst = await prisma.audit.for("Product").id(productId).atRevision(first);
    console.log(`  at rev ${first}:`, summarise(atFirst?.entity));

    const atLast = await prisma.audit.for("Product").id(productId).atRevision(last);
    console.log(`  at rev ${last}:`, summarise(atLast?.entity));

    console.log("\n── Diff ────────────────────────────────────────────────────");
    const diff = await prisma.audit.for("Product").id(productId).diff(first, last);
    for (const [field, change] of Object.entries(diff)) {
      console.log(`  ${field}: ${String(change.old)} -> ${String(change.new)}`);
    }
  }

  // A deleted row still answers "did this ever exist, and what was it?".
  const stockHistory = await prisma.audit.for("Stock").id(1).getRevisions();
  console.log("\n── Stock history (row was deleted) ─────────────────────────");
  for (const entry of stockHistory) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}  quantity=${String(entity.quantity)}`,
    );
  }

  const deletedAt = stockHistory.at(-1)?.revisionId;
  if (deletedAt !== undefined) {
    const afterDelete = await prisma.audit.for("Stock").id(1).atRevision(deletedAt);
    console.log(`  atRevision(${deletedAt}) after the DELETE: ${String(afterDelete)}`);
  }

  console.log("\n── Revisions ───────────────────────────────────────────────");
  for (const revision of (await prisma.audit.revisions()).reverse()) {
    const changes = revision.changes
      .map((change) => `${change.model}#${formatKey(change.id)} ${change.revType}`)
      .join(", ");
    console.log(
      `  rev ${String(revision.id).padStart(3)}  ${revision.username ?? "-"}  ${changes || "(no audited change)"}`,
    );
  }
}

function summarise(entity: unknown): string {
  if (!entity) return "does not exist";
  const record = entity as Record<string, unknown>;
  return `${String(record.name)} @ ${String(record.price)} ${String(record.currency)}`;
}

/** Start from a clean slate so the demo can be run repeatedly. */
async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "product_aud", "stock_aud", "order_line_aud", "revision", "Stock", "Product", "OrderLine", "Category" RESTART IDENTITY CASCADE',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
