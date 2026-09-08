/**
 * The checks every provider has to pass.
 *
 * Written against the Prisma Client interface rather than a generated one:
 * `run` is handed whichever client src/run.ts just generated, so the same
 * assertions travel across all three databases.
 */
import assert from "node:assert/strict";

import { loadMetadata, withAudit } from "prisma-audit";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

const halil = { userId: "42", username: "halil" };

/** Run every check against one client. Returns how many failed. */
export async function run(client: unknown, metadataPath: string): Promise<number> {
  const prisma: AnyClient = withAudit(client as any, {
    metadata: loadMetadata(metadataPath),
    userProvider: () => halil,
  });

  let failed = 0;

  for (const [name, check] of checks) {
    try {
      await check(prisma);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await prisma.$disconnect();
  return failed;
}

const checks: Array<[string, (prisma: AnyClient) => Promise<void>]> = [
  [
    "a revision is opened, and the next one gets a key of its own",
    async (prisma) => {
      // The check that catches a revision key the database cannot
      // autoincrement: on SQLite a BigInt key produces a table whose every
      // insert fails, and the first write here is where that shows.
      const first = await prisma.$auditTransaction(halil, async (tx: AnyClient) =>
        tx.product.create({ data: { name: "First", price: 10 } }),
      );
      const second = await prisma.$auditTransaction(halil, async (tx: AnyClient) =>
        tx.product.create({ data: { name: "Second", price: 20 } }),
      );

      const [a] = await prisma.audit.for("Product").id(first.id).getRevisions();
      const [b] = await prisma.audit.for("Product").id(second.id).getRevisions();

      assert.ok(a && b);
      assert.notEqual(String(a.revisionId), String(b.revisionId));
      assert.ok(Number(b.revisionId) > Number(a.revisionId));
      assert.equal(a.user.username, "halil");
    },
  ],
  [
    "a row's whole life is in the history",
    async (prisma) => {
      const product = await prisma.$auditTransaction(halil, async (tx: AnyClient) =>
        tx.product.create({ data: { name: "Phone", price: 100, currency: "USD" } }),
      );

      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.product.update({ where: { id: product.id }, data: { price: 150 } });
      });
      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.product.delete({ where: { id: product.id } });
      });

      const history = await prisma.audit.for("Product").id(product.id).getRevisions();
      assert.deepEqual(
        history.map((entry: AnyClient) => entry.revType),
        ["INSERT", "UPDATE", "DELETE"],
      );

      // The enum and the Decimal came back as they went in.
      assert.equal(history[0].entity.currency, "USD");
      assert.equal(Number(history[1].entity.price), 150);

      const gone = await prisma.audit
        .for("Product")
        .id(product.id)
        .atRevision(history[2].revisionId);
      assert.equal(gone, null, "atRevision past a DELETE should say the row is gone");

      const before = await prisma.audit
        .for("Product")
        .id(product.id)
        .atRevision(history[1].revisionId);
      assert.equal(Number(before.entity.price), 150);
    },
  ],
  [
    "one transaction is one revision across two models",
    async (prisma) => {
      const product = await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        const created = await tx.product.create({ data: { name: "Bundle", price: 10 } });
        await tx.stock.create({ data: { productId: created.id, quantity: 4 } });
        return created;
      });

      const [revision] = await prisma.audit.revisions(1);
      assert.deepEqual(
        revision.changes.map((change: AnyClient) => change.model).sort(),
        ["Product", "Stock"],
      );

      // Stock is [AuditTable(StockHistory)] and @@map("stock"): the reader is
      // asked for the model as the schema names it, on every provider.
      const stock = await prisma.audit.for("Stock").id(1).getRevisions();
      assert.equal(stock.length, 1);
      assert.equal(Number(stock[0].entity.productId), Number(product.id));
    },
  ],
  [
    "a [NotAudited] column never reaches the audit table",
    async (prisma) => {
      const product = await prisma.$auditTransaction(halil, async (tx: AnyClient) =>
        tx.product.create({
          data: { name: "Secretive", price: 1, internalCode: "SECRET" },
        }),
      );

      const history = await prisma.audit.for("Product").id(product.id).getRevisions();
      assert.ok(history.length > 0);
      assert.ok(history.every((entry: AnyClient) => !("internalCode" in entry.entity)));
    },
  ],
  [
    "a bulk write records one row per record it touched",
    async (prisma) => {
      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.product.createMany({
          data: [
            { name: "Bulk A", price: 7 },
            { name: "Bulk B", price: 7 },
          ],
        });
      });

      const [created] = await prisma.audit.revisions(1);
      assert.equal(created.changes.length, 2);

      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.product.updateMany({ where: { price: 7 }, data: { price: 8 } });
      });

      const [updated] = await prisma.audit.revisions(1);
      assert.equal(updated.changes.length, 2);
      assert.ok(updated.changes.every((change: AnyClient) => change.revType === "UPDATE"));
    },
  ],
  [
    "a composite key is a key everywhere it is used",
    async (prisma) => {
      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.order.create({ data: { id: 90, status: "open" } });
        await tx.orderLine.createMany({
          data: [
            { orderId: 90, lineNo: 1, quantity: 2 },
            { orderId: 90, lineNo: 2, quantity: 5 },
          ],
        });
      });

      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
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
        history.map((entry: AnyClient) => entry.revType),
        ["INSERT", "UPDATE"],
      );
      assert.equal(Number(history[1].entity.quantity), 9);
    },
  ],
  [
    "an aggregate reads the root together with its children",
    async (prisma) => {
      const order = prisma.audit.for("Order").id(90).aggregate();
      const revisions = await order.getRevisions();
      assert.equal(revisions.length, 2);

      const at = await order.atRevision(revisions.at(-1).revisionId);
      assert.deepEqual(
        (at?.children.lines ?? []).map((line: AnyClient) => Number(line.quantity)),
        [2, 9],
      );
    },
  ],
  [
    "a nested write records the row it reached",
    async (prisma) => {
      const product = await prisma.$auditTransaction(halil, async (tx: AnyClient) =>
        tx.product.create({
          data: { name: "Nested", price: 5, stock: { create: { quantity: 3 } } },
        }),
      );

      await prisma.$auditTransaction(halil, async (tx: AnyClient) => {
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { update: { quantity: 1 } } },
        });
      });

      const [latest] = await prisma.audit.revisions(1);
      assert.ok(
        latest.changes.some((change: AnyClient) => change.model === "Stock"),
        "the nested row was not recorded",
      );
    },
  ],
  [
    "a model with no annotation leaves no trace",
    async (prisma) => {
      const before = (await prisma.audit.revisions(1))[0]?.id;
      await prisma.category.create({ data: { name: "Untracked" } });
      const after = (await prisma.audit.revisions(1))[0]?.id;

      assert.equal(String(after), String(before));
    },
  ],
];
