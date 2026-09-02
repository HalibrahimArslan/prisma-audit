import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSchemaText } from "../src/parser/index.js";
import { runWithAuditContext } from "../src/runtime/context.js";
import {
  buildQueryExtension,
  type AuditOptions,
} from "../src/runtime/extension.js";
import type { AuditMetadata } from "../src/metadata.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCHEMA = `datasource db {
  provider = "postgresql"
}

[Auditable]
model Product {
  id    Int    @id @default(autoincrement())
  name  String
  price Int

  [NotAudited]
  internalCode String?

  categoryId Int?
  category   Category? @relation(fields: [categoryId], references: [id])
  stocks     Stock[]
}

[Auditable]
model Stock {
  id        Int @id @default(autoincrement())
  productId Int
  quantity  Int
}

[Auditable]
model OrderLine {
  orderId  Int
  lineNo   Int
  quantity Int

  @@id([orderId, lineNo])
}

model Category {
  id       Int       @id @default(autoincrement())
  name     String
  products Product[]
}
`;

const metadata: AuditMetadata = parseSchemaText(SCHEMA).metadata;

/* -------------------------------------------------------------------------- */
/* A Prisma Client stand-in                                                    */
/* -------------------------------------------------------------------------- */

type Row = Record<string, any>;

/** Matches the subset of Prisma's filter syntax the runtime itself produces. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;

  return Object.entries(where).every(([field, condition]) => {
    // The runtime asks for a set of composite-key rows as a list of alternatives.
    if (field === "OR") {
      return (condition as Row[]).some((alternative) => matches(row, alternative));
    }

    const value = row[field];

    if (condition !== null && typeof condition === "object") {
      const filter = condition as Row;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      if ("lt" in filter) return value < filter.lt;
      if ("lte" in filter) return value <= filter.lte;
      if ("gt" in filter) return value > filter.gt;
      if ("gte" in filter) return value >= filter.gte;
      return false;
    }

    return value === condition;
  });
}

function project(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };

  const picked: Row = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) picked[field] = row[field];
  }
  return picked;
}

/** One source table: enough of a Prisma delegate for the runtime to drive. */
class FakeTable {
  rows: Row[] = [];
  private nextId = 1;
  /** Every statement the runtime issued, in order, for cost assertions. */
  readonly calls: string[] = [];

  constructor(
    readonly model: string,
    readonly primaryKey: string[],
    /** Databases without `createManyAndReturn` simply do not have the method. */
    returning = true,
  ) {
    // An own property shadows the prototype method, so the delegate looks
    // exactly like one on a database that cannot insert with RETURNING.
    if (!returning) (this as any).createManyAndReturn = undefined;
  }

  /**
   * Prisma names a composite key as one nested argument — `where: { orderId_lineNo:
   * { … } }` — so unwrap it into the flat form the matcher works with. A
   * single-column key is already flat, and its compound name is the column
   * itself, so only a composite key is unwrapped.
   */
  private where(where: Row | undefined): Row | undefined {
    if (this.primaryKey.length < 2) return where;

    const name = this.primaryKey.join("_");
    const compound = where?.[name];
    if (!compound) return where;

    const { [name]: _nested, ...rest } = where as Row;
    return { ...rest, ...(compound as Row) };
  }

  private sameRow(a: Row, b: Row): boolean {
    return this.primaryKey.every((column) => a[column] === b[column]);
  }

  findMany(args: any = {}): Row[] {
    this.calls.push("findMany");
    const found = this.rows.filter((row) => matches(row, this.where(args.where)));
    const limited = args.take === undefined ? found : found.slice(0, args.take);
    return limited.map((row) => project(row, args.select));
  }

  findUnique(args: any): Row | null {
    this.calls.push("findUnique");
    const row = this.rows.find((candidate) => matches(candidate, this.where(args.where)));
    return row ? project(row, args.select) : null;
  }

  create(args: any): Row {
    this.calls.push("create");
    // A single-column key stands in for an autoincrement column; a composite
    // key is always supplied by the caller, as it is in the database.
    const generated =
      this.primaryKey.length === 1 && args.data[this.primaryKey[0] as string] === undefined
        ? { [this.primaryKey[0] as string]: this.nextId++ }
        : {};
    const row: Row = { ...generated, ...args.data };

    if (this.rows.some((existing) => this.sameRow(existing, row))) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }

    this.rows.push(row);
    return project(row, args.select);
  }

  createMany(args: any): { count: number } {
    this.calls.push("createMany");
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    for (const data of rows) this.create({ data });
    return { count: rows.length };
  }

  createManyAndReturn(args: any): Row[] {
    this.calls.push("createManyAndReturn");
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    return rows.map((data: Row) => this.create({ data, select: args.select }));
  }

  update(args: any): Row {
    this.calls.push("update");
    const row = this.rows.find((candidate) => matches(candidate, this.where(args.where)));
    if (!row) throw new Error(`${this.model}: row not found`);
    Object.assign(row, args.data);
    return project(row, args.select);
  }

  updateMany(args: any): { count: number } {
    this.calls.push("updateMany");
    const found = this.rows.filter((row) => matches(row, this.where(args.where)));
    const affected = args.limit === undefined ? found : found.slice(0, args.limit);
    for (const row of affected) Object.assign(row, args.data);
    return { count: affected.length };
  }

  delete(args: any): Row {
    this.calls.push("delete");
    const index = this.rows.findIndex((row) => matches(row, this.where(args.where)));
    if (index < 0) throw new Error(`${this.model}: row not found`);
    const [row] = this.rows.splice(index, 1) as [Row];
    return project(row, args.select);
  }

  deleteMany(args: any): { count: number } {
    this.calls.push("deleteMany");
    const found = this.rows.filter((row) => matches(row, this.where(args.where)));
    const affected = args.limit === undefined ? found : found.slice(0, args.limit);
    this.rows = this.rows.filter((row) => !affected.includes(row));
    return { count: affected.length };
  }

  upsert(args: any): Row {
    this.calls.push("upsert");
    const existing = this.rows.find((row) => matches(row, this.where(args.where)));
    return existing
      ? this.update({ where: args.where, data: args.update, select: args.select })
      : this.create({ data: args.create, select: args.select });
  }
}

/**
 * An audit table: keyed `(revisionId, ...key)`, which Prisma exposes as one
 * nested `revisionId_orderId_lineNo` argument.
 */
class FakeAuditTable {
  rows: Row[] = [];

  constructor(
    readonly model: string,
    readonly primaryKey: string[],
  ) {}

  private columns(): string[] {
    return ["revisionId", ...this.primaryKey];
  }

  private sameRow(a: Row, b: Row): boolean {
    return this.columns().every((column) => a[column] === b[column]);
  }

  createMany(args: any): { count: number } {
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    for (const data of rows) {
      if (this.rows.some((row) => this.sameRow(row, data))) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      this.rows.push({ ...data });
    }
    return { count: rows.length };
  }

  update(args: any): Row {
    const key = args.where[this.columns().join("_")];
    const row = this.rows.find((candidate) => this.sameRow(candidate, key));
    if (!row) throw new Error(`${this.model}: audit row not found`);
    Object.assign(row, args.data);
    return row;
  }
}

class FakeRevisionTable {
  rows: Row[] = [];
  private nextId = 1n;

  create(args: any): Row {
    const row = { id: this.nextId++, timestamp: new Date(), ...args.data };
    this.rows.push(row);
    return row;
  }
}

interface Harness {
  client: any;
  product: FakeTable;
  stock: FakeTable;
  /** A model keyed `@@id([orderId, lineNo])`, for the composite-key paths. */
  orderLine: FakeTable;
  productAud: FakeAuditTable;
  stockAud: FakeAuditTable;
  orderLineAud: FakeAuditTable;
  revision: FakeRevisionTable;
  warnings: string[];
}

/**
 * A client whose delegates route through the query extension, the way Prisma's
 * own `$extends` does — which is what makes the runtime's internal
 * re-dispatches (`createManyAndReturn`, the bypass) behave as they do in
 * practice.
 */
function harness(overrides: Partial<AuditOptions> = {}, returning = true): Harness {
  const product = new FakeTable("Product", ["id"], returning);
  const stock = new FakeTable("Stock", ["id"], returning);
  const orderLine = new FakeTable("OrderLine", ["orderId", "lineNo"], returning);
  const productAud = new FakeAuditTable("ProductAud", ["id"]);
  const stockAud = new FakeAuditTable("StockAud", ["id"]);
  const orderLineAud = new FakeAuditTable("OrderLineAud", ["orderId", "lineNo"]);
  const revision = new FakeRevisionTable();
  const warnings: string[] = [];

  const options: AuditOptions = {
    metadata,
    onNestedWrite: (model, field, target) => warnings.push(`${model}.${field} -> ${target}`),
    ...overrides,
  };

  const box = { client: undefined as any };
  const run = buildQueryExtension(box, options).query.$allModels.$allOperations;

  const client: any = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(client),
    revision,
    productAud,
    stockAud,
    orderLineAud,
  };

  for (const table of [product, stock, orderLine]) {
    // Prisma lower-cases only the first character: `OrderLine` -> `orderLine`.
    const delegate = table.model.charAt(0).toLowerCase() + table.model.slice(1);

    client[delegate] = new Proxy(
      {},
      {
        get: (_target, property) => {
          const operation = String(property);
          const raw = (table as any)[operation];
          if (typeof raw !== "function") return undefined;

          return (args: any) =>
            run({
              model: table.model,
              operation,
              args,
              query: async (forwarded: any) => raw.call(table, forwarded),
            });
        },
      },
    );
  }

  box.client = client;

  return {
    client,
    product,
    stock,
    orderLine,
    productAud,
    stockAud,
    orderLineAud,
    revision,
    warnings,
  };
}

/** Run a block as if it were inside `$auditTransaction`. */
function inRevision<T>(h: Harness, fn: () => Promise<T>, revisionId = 1n): Promise<T> {
  return runWithAuditContext(
    { revisionId, tx: h.client, written: new Map() },
    fn,
  );
}

/* -------------------------------------------------------------------------- */

describe("bulk writes", () => {
  it("audits one row per record an updateMany touched", async () => {
    const h = harness();
    h.product.rows.push(
      { id: 1, name: "a", price: 10, internalCode: "x", categoryId: null },
      { id: 2, name: "b", price: 10, internalCode: "y", categoryId: null },
      { id: 3, name: "c", price: 99, internalCode: "z", categoryId: null },
    );

    const result = await inRevision(h, () =>
      h.client.product.updateMany({ where: { price: 10 }, data: { price: 20 } }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.equal(h.productAud.rows.length, 2);

    // The audit row holds the state *after* the update, and never a
    // [NotAudited] column.
    for (const row of h.productAud.rows) {
      assert.equal(row.revType, "UPDATE");
      assert.equal(row.price, 20);
      assert.equal(row.revisionId, 1n);
      assert.ok(!("internalCode" in row));
    }

    assert.deepEqual(
      h.productAud.rows.map((row) => row.id),
      [1, 2],
    );
  });

  it("records a deleteMany from the rows as they were before the delete", async () => {
    const h = harness();
    h.product.rows.push(
      { id: 1, name: "a", price: 10, internalCode: null, categoryId: null },
      { id: 2, name: "b", price: 99, internalCode: null, categoryId: null },
    );

    const result = await inRevision(h, () =>
      h.client.product.deleteMany({ where: { price: 10 } }),
    );

    assert.deepEqual(result, { count: 1 });
    assert.equal(h.product.rows.length, 1);
    assert.deepEqual(h.productAud.rows, [
      { revisionId: 1n, revType: "DELETE", id: 1, name: "a", price: 10, categoryId: null },
    ]);
  });

  it("takes createMany through createManyAndReturn to learn the generated keys", async () => {
    const h = harness();

    const result = await inRevision(h, () =>
      h.client.product.createMany({
        data: [
          { name: "a", price: 1 },
          { name: "b", price: 2 },
        ],
      }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.ok(h.product.calls.includes("createManyAndReturn"));
    assert.deepEqual(
      h.productAud.rows.map((row) => [row.id, row.name, row.revType]),
      [
        [1, "a", "INSERT"],
        [2, "b", "INSERT"],
      ],
    );
  });

  it("falls back to a row-by-row insert where createManyAndReturn does not exist", async () => {
    const h = harness({}, false);

    const result = await inRevision(h, () =>
      h.client.product.createMany({
        data: [
          { name: "a", price: 1 },
          { name: "b", price: 2 },
        ],
      }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.equal(h.product.calls.filter((call) => call === "create").length, 2);
    assert.equal(h.productAud.rows.length, 2);
  });

  it("skips duplicates on the row-by-row path when the caller asked for it", async () => {
    const h = harness({}, false);
    h.product.rows.push({ id: 1, name: "taken", price: 1, categoryId: null });

    const result = await inRevision(h, () =>
      h.client.product.createMany({
        skipDuplicates: true,
        data: [
          { id: 1, name: "clash", price: 1 },
          { id: 2, name: "fresh", price: 2 },
        ],
      }),
    );

    assert.deepEqual(result, { count: 1 });
    assert.deepEqual(
      h.productAud.rows.map((row) => row.name),
      ["fresh"],
    );
  });

  it("audits createManyAndReturn and re-reads rows narrowed by select", async () => {
    const h = harness();

    const rows = await inRevision(h, () =>
      h.client.product.createManyAndReturn({
        data: [{ name: "a", price: 1 }],
        select: { id: true },
      }),
    );

    assert.deepEqual(rows, [{ id: 1 }]);
    // The caller only asked for the key, so the row was read back in full.
    assert.equal(h.productAud.rows[0]?.name, "a");
    assert.equal(h.productAud.rows[0]?.revType, "INSERT");
  });

  it("restricts a limited updateMany to the rows it recorded", async () => {
    const h = harness();
    h.product.rows.push(
      { id: 1, name: "a", price: 10, categoryId: null },
      { id: 2, name: "b", price: 10, categoryId: null },
      { id: 3, name: "c", price: 10, categoryId: null },
    );

    const result = await inRevision(h, () =>
      h.client.product.updateMany({ where: { price: 10 }, data: { price: 20 }, limit: 2 }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.equal(h.productAud.rows.length, 2);
    assert.equal(h.product.rows.filter((row) => row.price === 20).length, 2);
    assert.deepEqual(
      h.productAud.rows.map((row) => row.id),
      h.product.rows.filter((row) => row.price === 20).map((row) => row.id),
    );
  });

  it("records each audited model into its own audit table", async () => {
    const h = harness();
    h.stock.rows.push({ id: 1, productId: 1, quantity: 5 });

    await inRevision(h, () => h.client.stock.updateMany({ data: { quantity: 6 } }));

    assert.equal(h.stockAud.rows.length, 1);
    assert.equal(h.productAud.rows.length, 0);
  });
});

describe("composite primary keys", () => {
  it("audits every row an updateMany touched, key columns and all", async () => {
    const h = harness();
    h.orderLine.rows.push(
      { orderId: 1, lineNo: 1, quantity: 5 },
      { orderId: 1, lineNo: 2, quantity: 5 },
      { orderId: 2, lineNo: 1, quantity: 9 },
    );

    const result = await inRevision(h, () =>
      h.client.orderLine.updateMany({ where: { orderId: 1 }, data: { quantity: 7 } }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.deepEqual(h.orderLineAud.rows, [
      { revisionId: 1n, revType: "UPDATE", orderId: 1, lineNo: 1, quantity: 7 },
      { revisionId: 1n, revType: "UPDATE", orderId: 1, lineNo: 2, quantity: 7 },
    ]);
  });

  it("reads a limited bulk write back by naming each key in full", async () => {
    const h = harness();
    h.orderLine.rows.push(
      { orderId: 1, lineNo: 1, quantity: 5 },
      { orderId: 1, lineNo: 2, quantity: 5 },
      { orderId: 1, lineNo: 3, quantity: 5 },
    );

    const result = await inRevision(h, () =>
      h.client.orderLine.deleteMany({ where: { orderId: 1 }, limit: 2 }),
    );

    assert.deepEqual(result, { count: 2 });
    assert.equal(h.orderLine.rows.length, 1);
    assert.deepEqual(
      h.orderLineAud.rows.map((row) => [row.orderId, row.lineNo, row.revType]),
      [
        [1, 1, "DELETE"],
        [1, 2, "DELETE"],
      ],
    );
  });

  it("re-reads a row narrowed by select through its compound key", async () => {
    const h = harness();
    h.orderLine.rows.push({ orderId: 1, lineNo: 1, quantity: 5 });

    const updated = await inRevision(h, () =>
      h.client.orderLine.update({
        where: { orderId_lineNo: { orderId: 1, lineNo: 1 } },
        data: { quantity: 8 },
        select: { quantity: true },
      }),
    );

    // The caller asked for one column, so the audit row was filled from a re-read.
    assert.deepEqual(updated, { quantity: 8 });
    assert.deepEqual(h.orderLineAud.rows, [
      { revisionId: 1n, revType: "UPDATE", orderId: 1, lineNo: 1, quantity: 8 },
    ]);
  });

  it("keeps one audit row for a key touched twice in a revision", async () => {
    const h = harness();
    h.orderLine.rows.push({ orderId: 1, lineNo: 1, quantity: 5 });

    await inRevision(h, async () => {
      await h.client.orderLine.update({
        where: { orderId_lineNo: { orderId: 1, lineNo: 1 } },
        data: { quantity: 6 },
      });
      await h.client.orderLine.updateMany({ where: { orderId: 1 }, data: { quantity: 7 } });
    });

    assert.equal(h.orderLineAud.rows.length, 1);
    assert.equal(h.orderLineAud.rows[0]?.quantity, 7);
  });

  it("tells two rows apart when one key column matches and the other does not", async () => {
    const h = harness();

    await inRevision(h, () =>
      h.client.orderLine.createMany({
        data: [
          { orderId: 1, lineNo: 1, quantity: 5 },
          { orderId: 1, lineNo: 2, quantity: 5 },
        ],
      }),
    );

    assert.equal(h.orderLineAud.rows.length, 2);
    assert.deepEqual(
      h.orderLineAud.rows.map((row) => row.lineNo),
      [1, 2],
    );
    assert.ok(h.orderLineAud.rows.every((row) => row.revType === "INSERT"));
  });
});

describe("upsert", () => {
  it("records an INSERT when the row is new", async () => {
    const h = harness();

    await inRevision(h, () =>
      h.client.product.upsert({
        where: { id: 1 },
        create: { name: "a", price: 1 },
        update: { price: 2 },
      }),
    );

    assert.equal(h.productAud.rows.length, 1);
    assert.equal(h.productAud.rows[0]?.revType, "INSERT");
    assert.equal(h.productAud.rows[0]?.name, "a");
  });

  it("records an UPDATE when the row was already there", async () => {
    const h = harness();
    h.product.rows.push({ id: 1, name: "a", price: 1, categoryId: null });

    await inRevision(h, () =>
      h.client.product.upsert({
        where: { id: 1 },
        create: { name: "a", price: 1 },
        update: { price: 2 },
      }),
    );

    assert.equal(h.productAud.rows.length, 1);
    assert.equal(h.productAud.rows[0]?.revType, "UPDATE");
    assert.equal(h.productAud.rows[0]?.price, 2);
  });
});

describe("a row touched twice in one revision", () => {
  it("keeps a single audit row holding the final state", async () => {
    const h = harness();
    h.product.rows.push({ id: 1, name: "a", price: 10, categoryId: null });

    await inRevision(h, async () => {
      await h.client.product.update({ where: { id: 1 }, data: { price: 20 } });
      await h.client.product.updateMany({ where: { id: 1 }, data: { price: 30 } });
    });

    assert.equal(h.productAud.rows.length, 1);
    assert.equal(h.productAud.rows[0]?.price, 30);
    assert.equal(h.productAud.rows[0]?.revType, "UPDATE");
  });

  it("stays an INSERT when the row was also created in that revision", async () => {
    const h = harness();

    await inRevision(h, async () => {
      const created = await h.client.product.create({ data: { name: "a", price: 1 } });
      await h.client.product.update({ where: { id: created.id }, data: { price: 2 } });
    });

    assert.equal(h.productAud.rows.length, 1);
    assert.equal(h.productAud.rows[0]?.revType, "INSERT");
    assert.equal(h.productAud.rows[0]?.price, 2);
  });

  it("ends as a DELETE when the row is removed later in the revision", async () => {
    const h = harness();
    h.product.rows.push({ id: 1, name: "a", price: 10, categoryId: null });

    await inRevision(h, async () => {
      await h.client.product.update({ where: { id: 1 }, data: { price: 20 } });
      await h.client.product.deleteMany({ where: { id: 1 } });
    });

    assert.equal(h.productAud.rows.length, 1);
    assert.equal(h.productAud.rows[0]?.revType, "DELETE");
  });
});

describe("revisions", () => {
  it("opens one for a bulk write made outside $auditTransaction", async () => {
    const h = harness({ userProvider: () => ({ userId: "42", username: "halil" }) });
    h.product.rows.push(
      { id: 1, name: "a", price: 10, categoryId: null },
      { id: 2, name: "b", price: 10, categoryId: null },
    );

    const result = await h.client.product.updateMany({
      where: { price: 10 },
      data: { price: 20 },
    });

    assert.deepEqual(result, { count: 2 });
    assert.equal(h.revision.rows.length, 1);
    assert.equal(h.revision.rows[0]?.username, "halil");
    assert.equal(h.productAud.rows.length, 2);
    assert.ok(h.productAud.rows.every((row) => row.revisionId === 1n));
  });

  it("refuses a bulk write with onMissingRevision: error", async () => {
    const h = harness({ onMissingRevision: "error" });

    await assert.rejects(
      () => h.client.product.deleteMany({ where: { price: 10 } }),
      /outside \$auditTransaction/,
    );
  });

  it("performs the write and records nothing with onMissingRevision: skip", async () => {
    const h = harness({ onMissingRevision: "skip" });
    h.product.rows.push({ id: 1, name: "a", price: 10, categoryId: null });

    await h.client.product.deleteMany({ where: { price: 10 } });

    assert.equal(h.product.rows.length, 0);
    assert.equal(h.productAud.rows.length, 0);
    assert.equal(h.revision.rows.length, 0);
  });
});

describe("nested writes", () => {
  it("warns once per relation that reaches an audited model", async () => {
    const h = harness();
    h.product.rows.push({ id: 1, name: "a", price: 10, categoryId: null });

    await inRevision(h, async () => {
      await h.client.product.update({
        where: { id: 1 },
        data: { name: "b", stocks: { create: { quantity: 1 } } },
      });
      await h.client.product.update({
        where: { id: 1 },
        data: { name: "c", stocks: { create: { quantity: 2 } } },
      });
    });

    assert.deepEqual(h.warnings, ["Product.stocks -> Stock"]);
  });

  it("stays quiet for a relation to a model that is not audited", async () => {
    const h = harness();
    h.product.rows.push({ id: 1, name: "a", price: 10, categoryId: null });

    await inRevision(h, () =>
      h.client.product.update({
        where: { id: 1 },
        data: { category: { connect: { id: 1 } } },
      }),
    );

    assert.deepEqual(h.warnings, []);
  });
});
