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
  await nested(category.id);
  await aggregate();
  await enforcement();
}

/**
 * Enforcement below the application. Payment is [AuditTriggers], so a database
 * trigger writes its audit rows and a statement that never went through Prisma
 * is recorded just the same.
 */
async function enforcement(): Promise<void> {
  // A mixed transaction: Payment's audit row is the trigger's to write and
  // Order's is the runtime's, and both land under the one revision — the
  // runtime publishes it on the transaction before either write runs.
  const payment = await prisma.$auditTransaction(halil, async (tx) => {
    const created = await tx.payment.create({
      data: { orderId: 1, amount: 45_000, status: "authorised" },
    });

    await tx.order.update({ where: { id: 1 }, data: { status: "paid" } });

    return created;
  });

  // Raw SQL on the connection, the way another service or a psql session
  // writes. The extension never sees it; the trigger does, and opens a
  // revision of its own because nothing published one.
  await prisma.$executeRawUnsafe(
    "UPDATE payment SET status = $1 WHERE id = $2",
    "captured",
    payment.id,
  );
  await prisma.$executeRawUnsafe("DELETE FROM payment WHERE id = $1", payment.id);

  console.log("\n── Enforcement: a trigger-backed model's history ───────────");
  for (const entry of await prisma.audit.for("Payment").id(payment.id).getRevisions()) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}` +
        `  by ${(entry.user.username ?? "-").padEnd(6)}  status=${String(entity.status)}`,
    );
  }

  // The first of those revisions is the one the Order update is recorded under
  // too: one unit of work, one revision, whichever half wrote the row.
  console.log("\n── Enforcement: what each of those revisions touched ───────");
  for (const revision of (await prisma.audit.revisions(3)).reverse()) {
    const changes = revision.changes
      .map((change) => `${change.model}#${formatKey(change.id)} ${change.revType}`)
      .join(", ");
    console.log(`  rev ${String(revision.id).padStart(3)}  ${revision.username ?? "-"}  ${changes}`);
  }
}

/**
 * An aggregate: the order and the lines that belong to it. Nothing extra is
 * stored for this — a line's audit row already carries the order it pointed at,
 * so the order can be reconstructed with its lines as of any revision.
 */
async function aggregate(): Promise<void> {
  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.order.update({ where: { id: 1 }, data: { status: "shipped" } });
  });

  const order = prisma.audit.for("Order").id(1).aggregate();

  console.log("\n── Aggregate: every revision that touched order 1 ──────────");
  for (const revision of await order.getRevisions()) {
    const changes = revision.changes
      .map((change) => `${change.model}#${formatKey(change.id)} ${change.revType}`)
      .join(", ");
    console.log(
      `  rev ${String(revision.revisionId).padStart(3)}  ${revision.user.username ?? "-"}  ${changes}`,
    );
  }

  const revisions = await order.getRevisions();
  const first = revisions[0]?.revisionId;
  const last = revisions.at(-1)?.revisionId;

  for (const revisionId of [first, last]) {
    if (revisionId === undefined) continue;

    const at = await order.atRevision(revisionId);
    const entity = at?.entity as Record<string, unknown>;
    const lines = (at?.children.lines ?? [])
      .map((line) => `line ${String(line.lineNo)} x${String(line.quantity)}`)
      .join(", ");

    console.log(`\n  order 1 at rev ${revisionId}: ${String(entity.status)}  [${lines}]`);
  }
}

/**
 * A nested write reaches a second model inside one Prisma call, and the
 * extension never sees an operation of its own for it. prisma-audit reads the
 * rows the payload can reach before and after the statement and records the
 * difference — the statement itself is left exactly as it was written.
 */
async function nested(categoryId: number): Promise<void> {
  const created = await prisma.$auditTransaction(halil, async (tx) =>
    tx.product.create({
      data: {
        name: "Pixel Fold",
        price: 60_000,
        categoryId,
        stock: { create: { quantity: 4 } },
      },
    }),
  );

  await prisma.$auditTransaction(ahmet, async (tx) => {
    await tx.product.update({
      where: { id: created.id },
      data: {
        price: 58_000,
        stock: { update: { quantity: 2 } },
      },
    });
  });

  // The nested delete leaves the stock row's last state in the history.
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.update({
      where: { id: created.id },
      data: { stock: { delete: true } },
    });
  });

  console.log("\n── Nested writes: what each revision recorded ──────────────");
  for (const revision of (await prisma.audit.revisions(3)).reverse()) {
    const changes = revision.changes
      .map((change) => `${change.model}#${formatKey(change.id)} ${change.revType}`)
      .join(", ");
    console.log(`  rev ${String(revision.id).padStart(3)}  ${revision.username ?? "-"}  ${changes}`);
  }

  const stockId = (await prisma.audit.revisions(3))
    .flatMap((revision) => revision.changes)
    .find((change) => change.model === "Stock")?.id;

  console.log("\n── Nested writes: the stock row's own history ──────────────");
  for (const entry of await prisma.audit.for("Stock").id(stockId).getRevisions()) {
    const entity = entry.entity as Record<string, unknown>;
    console.log(
      `  rev ${String(entry.revisionId).padStart(3)}  ${entry.revType.padEnd(6)}` +
        `  by ${(entry.user.username ?? "-").padEnd(6)}  quantity=${String(entity.quantity)}`,
    );
  }
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
    await tx.order.createMany({
      data: [
        { id: 1, status: "open" },
        { id: 2, status: "open" },
      ],
    });
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
  // Stock is [AuditTable(StockHistory)]: the reader is still asked for "Stock",
  // the model as the schema names it, and finds its history in stock_history.
  const stockHistory = await prisma.audit.for("Stock").id(1).getRevisions();
  console.log("\n── Stock history (in the renamed audit table) ──────────────");
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
    'TRUNCATE TABLE "product_aud", "stock_history", "order_line_aud", "order_aud", "payment_aud", "revision", "Stock", "Product", "OrderLine", "Order", "payment", "Category" RESTART IDENTITY CASCADE',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
