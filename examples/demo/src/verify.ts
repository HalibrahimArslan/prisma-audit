/**
 * The end-to-end checks CI gates on.
 *
 * The unit suite covers the logic; this covers what only a real database can
 * answer — the generated DDL, the triggers, the transaction-local settings the
 * revision travels on, and how a Decimal or an enum survives the round trip
 * into an audit table and back.
 *
 *   pnpm db:up && pnpm audit:generate && pnpm migrate && pnpm verify
 */
import assert from "node:assert/strict";
import process from "node:process";

import { PrismaPg } from "@prisma/adapter-pg";
import { loadMetadata, withAudit } from "prisma-audit";

import { PrismaClient } from "./generated/prisma/client.js";
import { prisma, setCurrentUser } from "./prisma.js";

const halil = { userId: "42", username: "halil" };

/** A second client of the same database, with the triggers told to stand down. */
const suppressed = withAudit(
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  {
    metadata: loadMetadata(
      new URL("../prisma/.audit/audit.metadata.json", import.meta.url).pathname,
    ),
    userProvider: () => halil,
    triggers: "suppress",
  },
);

const checks: Array<[string, () => Promise<void>]> = [];

function check(name: string, fn: () => Promise<void>): void {
  checks.push([name, fn]);
}

/* -------------------------------------------------------------------------- */

check("a transaction is one revision, whichever half records the row", async () => {
  const payment = await prisma.$auditTransaction(halil, async (tx) => {
    const created = await tx.payment.create({
      data: { orderId: 1, amount: 45_000, status: "authorised" },
    });
    await tx.category.create({ data: { name: "Wearables" } });
    await tx.product.create({ data: { name: "Watch", price: 12_000 } });
    return created;
  });

  const [entry] = await prisma.audit.for("Payment").id(payment.id).getRevisions();
  assert.ok(entry, "the trigger recorded nothing for a write through Prisma");
  assert.equal(entry.revType, "INSERT");
  assert.equal(entry.user.username, "halil", "the trigger did not see the acting user");

  // The Product row is the runtime's to record and the Payment row the
  // trigger's; both belong to the revision the runtime opened.
  const [revision] = await prisma.audit.revisions(1);
  assert.equal(revision?.id, entry.revisionId);
  assert.deepEqual(
    revision.changes.map((change) => change.model).sort(),
    ["Payment", "Product"],
    "one unit of work was split across revisions",
  );
});

check("a write that never went through Prisma is recorded all the same", async () => {
  const payment = await prisma.$auditTransaction(halil, async (tx) =>
    tx.payment.create({ data: { orderId: 2, amount: 10, status: "authorised" } }),
  );

  await prisma.$executeRawUnsafe(
    "UPDATE payment SET status = $1 WHERE id = $2",
    "captured",
    payment.id,
  );
  await prisma.$executeRawUnsafe("DELETE FROM payment WHERE id = $1", payment.id);

  const history = await prisma.audit.for("Payment").id(payment.id).getRevisions();
  assert.deepEqual(
    history.map((entry) => entry.revType),
    ["INSERT", "UPDATE", "DELETE"],
  );

  // A raw statement opens a revision of its own, and has no user to put on it.
  const raw = history.slice(1);
  assert.ok(raw.every((entry) => entry.user.username === null));
  assert.equal(new Set(history.map((entry) => entry.revisionId)).size, 3);

  const gone = await prisma.audit.for("Payment").id(payment.id).atRevision(history[2]!.revisionId);
  assert.equal(gone, null, "atRevision past a DELETE should say the row is gone");
});

check("suppression leaves the row to the runtime, and only once", async () => {
  const payment = await suppressed.$auditTransaction(halil, async (tx) =>
    tx.payment.create({ data: { orderId: 3, amount: 99, status: "authorised" } }),
  );

  await suppressed.$auditTransaction(halil, async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "captured" } });
  });

  const history = await prisma.audit.for("Payment").id(payment.id).getRevisions();
  assert.deepEqual(
    history.map((entry) => entry.revType),
    ["INSERT", "UPDATE"],
    "the trigger and the runtime both recorded the write, or neither did",
  );
  assert.ok(history.every((entry) => entry.user.username === "halil"));
});

check("a [NotAudited] column never reaches the audit table", async () => {
  const product = await prisma.$auditTransaction(halil, async (tx) =>
    tx.product.create({
      data: { name: "Tablet", price: 30_000, internalCode: "SECRET-9" },
    }),
  );

  const history = await prisma.audit.for("Product").id(product.id).getRevisions();
  assert.ok(history.length > 0);
  assert.ok(
    history.every((entry) => !("internalCode" in (entry.entity as object))),
    "internalCode leaked into the history",
  );
});

check("a Decimal and an enum survive the round trip", async () => {
  const product = await prisma.$auditTransaction(halil, async (tx) =>
    tx.product.create({ data: { name: "Laptop", price: "1234.56", currency: "USD" } }),
  );

  const [entry] = await prisma.audit.for("Product").id(product.id).getRevisions();
  const entity = entry!.entity as Record<string, unknown>;
  assert.equal(String(entity.price), "1234.56");
  assert.equal(entity.currency, "USD");
});

check("a bulk write records one row per record it touched", async () => {
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.createMany({
      data: [
        { name: "Bulk A", price: 1 },
        { name: "Bulk B", price: 1 },
      ],
    });
  });

  const [created] = await prisma.audit.revisions(1);
  assert.equal(created?.changes.length, 2);

  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.updateMany({ where: { price: 1 }, data: { price: 2 } });
  });

  const [updated] = await prisma.audit.revisions(1);
  assert.equal(updated?.changes.length, 2);
  assert.ok(updated.changes.every((change) => change.revType === "UPDATE"));
});

check("a composite key is a key everywhere it is used", async () => {
  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.order.create({ data: { id: 90, status: "open" } });
    await tx.orderLine.createMany({
      data: [
        { orderId: 90, lineNo: 1, quantity: 2 },
        { orderId: 90, lineNo: 2, quantity: 5 },
      ],
    });
  });

  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.orderLine.update({
      where: { orderId_lineNo: { orderId: 90, lineNo: 2 } },
      data: { quantity: 9 },
    });
  });

  const history = await prisma.audit
    .for("OrderLine")
    .id({ orderId: 90, lineNo: 2 })
    .getRevisions();

  assert.deepEqual(
    history.map((entry) => entry.revType),
    ["INSERT", "UPDATE"],
  );
  assert.equal((history[1]!.entity as Record<string, unknown>).quantity, 9);

  // The untouched line has a history of its own, under the same first revision.
  const other = await prisma.audit.for("OrderLine").id({ orderId: 90, lineNo: 1 }).getRevisions();
  assert.equal(other.length, 1);
  assert.equal(other[0]!.revisionId, history[0]!.revisionId);
});

check("an aggregate reads the root together with its children", async () => {
  const order = prisma.audit.for("Order").id(90).aggregate();
  const revisions = await order.getRevisions();

  // Creating the order and changing one of its lines are both revisions of it.
  assert.equal(revisions.length, 2);

  const at = await order.atRevision(revisions.at(-1)!.revisionId);
  assert.deepEqual(
    (at?.children.lines ?? []).map((line) => line.quantity),
    [2, 9],
    "the aggregate did not come back as its lines stood then",
  );
});

check("a nested write records the rows it reached", async () => {
  const product = await prisma.$auditTransaction(halil, async (tx) =>
    tx.product.create({
      data: { name: "Nested", price: 100, stock: { create: { quantity: 4 } } },
    }),
  );

  await prisma.$auditTransaction(halil, async (tx) => {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { update: { quantity: 1 } } },
    });
  });

  // The row the payload reached is recorded beside the row the call named --
  // the parent is recorded because the caller updated it, whether or not any
  // of its own columns moved.
  const [latest] = await prisma.audit.revisions(1);
  assert.deepEqual(
    latest?.changes.map((change) => change.model).sort(),
    ["Product", "Stock"],
    "the nested row was not recorded",
  );

  const stock = await prisma.audit.for("Stock").id(1).getRevisions();
  assert.deepEqual(
    stock.map((entry) => (entry.entity as Record<string, unknown>).quantity),
    [4, 1],
    "the nested row's history is not what the payload did to it",
  );
});

check("a model with no annotation leaves no trace", async () => {
  const before = (await prisma.audit.revisions(1))[0]?.id;

  setCurrentUser(halil);
  await prisma.category.create({ data: { name: "Untracked" } });

  const after = (await prisma.audit.revisions(1))[0]?.id;
  assert.equal(after, before, "an unannotated model produced a revision");
});

/* -------------------------------------------------------------------------- */

/** Start from an empty database, so a check can count what it just wrote. */
async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "product_aud", "stock_history", "order_line_aud", "order_aud", "payment_aud", "revision", "Stock", "Product", "OrderLine", "Order", "payment", "Category" RESTART IDENTITY CASCADE',
  );
}

async function main(): Promise<void> {
  await reset();

  let failed = 0;

  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await suppressed.$disconnect();
    await prisma.$disconnect();
  });
