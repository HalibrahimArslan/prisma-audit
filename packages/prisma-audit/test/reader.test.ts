import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSchemaText } from "../src/parser/index.js";
import { AuditReader } from "../src/reader/audit-reader.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCHEMA = `[Auditable]
model Product {
  id    Int    @id @default(autoincrement())
  name  String
  price Int
}

[Auditable]
model Order {
  id     Int         @id
  status String

  [AuditedRelation]
  lines  OrderLine[]

  [AuditedRelation]
  notes  Note[]
}

// Its key does not include the foreign key, so it can be moved between orders.
[Auditable]
model Note {
  id      Int    @id
  orderId Int
  text    String
  order   Order  @relation(fields: [orderId], references: [id])
}

[Auditable]
model OrderLine {
  orderId  Int
  lineNo   Int
  quantity Int
  order    Order @relation(fields: [orderId], references: [id])

  @@id([orderId, lineNo])
}
`;

const { metadata } = parseSchemaText(SCHEMA);

type Row = Record<string, any>;

const REVISION = { timestamp: new Date("2026-01-01T00:00:00Z"), userId: "42", username: "halil" };

/** Matches the flat equality and `lte`/`gte` filters the reader itself builds. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") {
      return (condition as Row[]).some((alternative) => matches(row, alternative));
    }

    const value = row[field];

    if (condition !== null && typeof condition === "object") {
      const filter = condition as Row;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      if ("lte" in filter && !(value <= filter.lte)) return false;
      if ("gte" in filter && !(value >= filter.gte)) return false;
      return true;
    }

    return value === condition;
  });
}

/** An audit table holding rows already joined to their revision. */
class FakeAuditTable {
  /** Every `where` the reader sent, so the key filter itself can be asserted. */
  readonly queries: Row[] = [];

  constructor(readonly rows: Row[]) {}

  findMany(args: any): Row[] {
    this.queries.push(args.where);

    const found = this.rows
      .filter((row) => matches(row, args.where))
      .filter((row, index, rows) => !args.distinct || first(rows, row, args.distinct, index))
      .sort((a, b) =>
        args.orderBy?.revisionId === "desc"
          ? Number(b.revisionId - a.revisionId)
          : Number(a.revisionId - b.revisionId),
      );

    return (args.take === undefined ? found : found.slice(0, args.take)).map((row) => ({
      ...row,
      revision: REVISION,
    }));
  }
}

/** Whether this is the first row with these column values, for `distinct`. */
function first(rows: Row[], row: Row, columns: string[], index: number): boolean {
  return (
    rows.findIndex((candidate) =>
      columns.every((column) => candidate[column] === row[column]),
    ) === index
  );
}

/** The audit rows each table holds, for one test. */
interface Tables {
  product?: Row[];
  order?: Row[];
  orderLine?: Row[];
  note?: Row[];
}

function reader(tables: Tables = {}) {
  const productRows = tables.product ?? [];
  const orderRows = tables.order ?? [];
  const orderLineRows = tables.orderLine ?? [];
  const noteRows = tables.note ?? [];

  const productAud = new FakeAuditTable(productRows);
  const orderLineAud = new FakeAuditTable(orderLineRows);
  const orderAud = new FakeAuditTable(orderRows);
  const noteAud = new FakeAuditTable(noteRows);

  /** The revisions referenced by any of the audit rows above. */
  const revisions = [...productRows, ...orderLineRows, ...orderRows, ...noteRows]
    .map((row) => row.revisionId as bigint)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort((a, b) => Number(a - b))
    .map((id) => ({ id, ...REVISION }));

  const client: any = {
    productAud,
    orderLineAud,
    orderAud,
    noteAud,
    revision: {
      findMany: (args: any) =>
        args.include
          ? [
              {
                id: 1n,
                ...REVISION,
                ...(args.include.productAud ? { productAud: productRows } : {}),
                ...(args.include.orderLineAud ? { orderLineAud: orderLineRows } : {}),
                ...(args.include.orderAud ? { orderAud: orderRows } : {}),
                ...(args.include.noteAud ? { noteAud: noteRows } : {}),
              },
            ]
          : revisions.filter((revision) => matches(revision, args.where)),
    },
  };

  return { audit: new AuditReader(client, metadata), productAud, orderLineAud, orderAud };
}

/** An aggregate reader over `Order` 1, for the tests that only need one. */
function order(tables: Tables) {
  return reader(tables).audit.for("Order").id(1);
}

describe("AuditQuery", () => {
  it("filters a single-column key by the value itself", async () => {
    const { audit, productAud } = reader({
      product: [
        { revisionId: 1n, revType: "INSERT", id: 10, name: "a", price: 1 },
        { revisionId: 2n, revType: "UPDATE", id: 20, name: "b", price: 2 },
      ],
    });

    const history = await audit.for("Product").id(10).getRevisions();

    assert.deepEqual(productAud.queries[0], { id: 10 });
    assert.deepEqual(
      history.map((entry) => entry.entity),
      [{ id: 10, name: "a", price: 1 }],
    );
    assert.equal(history[0]?.user.username, "halil");
  });

  it("filters a composite key on every one of its columns", async () => {
    const { audit, orderLineAud } = reader({
      orderLine: [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 2n, revType: "UPDATE", orderId: 1, lineNo: 2, quantity: 9 },
      ],
    });

    const history = await audit
      .for("OrderLine")
      .id({ orderId: 1, lineNo: 2 })
      .getRevisions();

    assert.deepEqual(orderLineAud.queries[0], { orderId: 1, lineNo: 2 });
    assert.deepEqual(
      history.map((entry) => entry.entity),
      [{ orderId: 1, lineNo: 2, quantity: 9 }],
    );
  });

  it("refuses a composite key given as a bare value, and names the columns", () => {
    const { audit } = reader();

    assert.throws(
      () => audit.for("OrderLine").id(1),
      /composite primary key.*orderId.*lineNo/s,
    );
  });

  it("reports a row as gone once its last revision was a DELETE", async () => {
    const { audit } = reader({
      orderLine: [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 3n, revType: "DELETE", orderId: 1, lineNo: 1, quantity: 5 },
      ],
    });

    const line = audit.for("OrderLine").id({ orderId: 1, lineNo: 1 });

    assert.notEqual(await line.atRevision(2n), null);
    assert.equal(await line.atRevision(3n), null);
  });

  it("diffs a composite-key row across two revisions", async () => {
    const { audit } = reader({
      orderLine: [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 2n, revType: "UPDATE", orderId: 1, lineNo: 1, quantity: 8 },
      ],
    });

    const diff = await audit.for("OrderLine").id({ orderId: 1, lineNo: 1 }).diff(1n, 2n);

    assert.deepEqual(diff, { quantity: { old: 5, new: 8 } });
  });
});

describe("AuditReader.revisions", () => {
  it("reports a change under the key shape that .id() accepts", async () => {
    const { audit } = reader({
      product: [{ revisionId: 1n, revType: "UPDATE", id: 10, name: "a", price: 1 }],
      orderLine: [{ revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 2, quantity: 5 }],
    });

    const [revision] = await audit.revisions();

    assert.deepEqual(revision?.changes, [
      { model: "Product", revType: "UPDATE", id: 10 },
      { model: "OrderLine", revType: "INSERT", id: { orderId: 1, lineNo: 2 } },
    ]);

    // Which is exactly what a follow-up history query takes.
    for (const change of revision?.changes ?? []) {
      await audit.for(change.model).id(change.id).getRevisions();
    }
  });
});

describe("AggregateQuery", () => {
  /** An order whose lines are added, changed, moved away and deleted. */
  const ORDER = [
    { revisionId: 1n, revType: "INSERT", id: 1, status: "open" },
    { revisionId: 5n, revType: "UPDATE", id: 1, status: "shipped" },
  ];

  const LINES = [
    { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 2 },
    { revisionId: 2n, revType: "INSERT", orderId: 1, lineNo: 2, quantity: 7 },
    { revisionId: 3n, revType: "UPDATE", orderId: 1, lineNo: 1, quantity: 4 },
    { revisionId: 4n, revType: "DELETE", orderId: 1, lineNo: 2, quantity: 7 },
  ];

  it("reconstructs the children the root had at that revision", async () => {
    const at2 = await order({ order: ORDER, orderLine: LINES }).aggregate().atRevision(2n);

    assert.deepEqual(at2?.entity, { id: 1, status: "open" });
    assert.deepEqual(at2?.children.lines, [
      { orderId: 1, lineNo: 1, quantity: 2 },
      { orderId: 1, lineNo: 2, quantity: 7 },
    ]);
  });

  it("gives each child the state it held at that revision", async () => {
    const at3 = await order({ order: ORDER, orderLine: LINES }).aggregate().atRevision(3n);

    assert.deepEqual(at3?.children.lines, [
      { orderId: 1, lineNo: 1, quantity: 4 },
      { orderId: 1, lineNo: 2, quantity: 7 },
    ]);
  });

  it("drops a child that had been deleted by then", async () => {
    const at5 = await order({ order: ORDER, orderLine: LINES }).aggregate().atRevision(5n);

    assert.deepEqual(at5?.entity, { id: 1, status: "shipped" });
    assert.deepEqual(at5?.children.lines, [{ orderId: 1, lineNo: 1, quantity: 4 }]);
  });

  it("drops a child that had been moved to another root", async () => {
    const notes = order({
      order: ORDER,
      note: [
        { revisionId: 1n, revType: "INSERT", id: 1, orderId: 1, text: "call back" },
        // Reassigned: from this revision on the note belongs to order 2.
        { revisionId: 2n, revType: "UPDATE", id: 1, orderId: 2, text: "call back" },
      ],
    }).aggregate("notes");

    assert.deepEqual((await notes.atRevision(1n))?.children.notes, [
      { id: 1, orderId: 1, text: "call back" },
    ]);
    assert.deepEqual((await notes.atRevision(2n))?.children.notes, []);
  });

  it("returns null for a revision before the root existed", async () => {
    assert.equal(
      await order({ order: ORDER, orderLine: LINES }).aggregate().atRevision(0n),
      null,
    );
  });

  it("lists every revision that changed the root or one of its children", async () => {
    const revisions = await order({ order: ORDER, orderLine: LINES })
      .aggregate("lines")
      .getRevisions();

    assert.deepEqual(
      revisions.map((revision) => [revision.revisionId, revision.changes]),
      [
        [
          1n,
          [
            { model: "Order", id: 1, revType: "INSERT" },
            { model: "OrderLine", relation: "lines", id: { orderId: 1, lineNo: 1 }, revType: "INSERT" },
          ],
        ],
        [
          2n,
          [
            { model: "OrderLine", relation: "lines", id: { orderId: 1, lineNo: 2 }, revType: "INSERT" },
          ],
        ],
        [
          3n,
          [
            { model: "OrderLine", relation: "lines", id: { orderId: 1, lineNo: 1 }, revType: "UPDATE" },
          ],
        ],
        [
          4n,
          [
            { model: "OrderLine", relation: "lines", id: { orderId: 1, lineNo: 2 }, revType: "DELETE" },
          ],
        ],
        [5n, [{ model: "Order", id: 1, revType: "UPDATE" }]],
      ],
    );
  });

  it("takes a relation by name as well as from [AuditedRelation]", async () => {
    const tables = { order: ORDER, orderLine: LINES };

    const named = await order(tables).aggregate("lines").atRevision(3n);
    const declared = await order(tables).aggregate().atRevision(3n);

    assert.deepEqual(named?.children.lines, declared?.children.lines);
  });

  it("refuses a model with no aggregate to read", () => {
    const { audit } = reader();

    assert.throws(
      () => audit.for("Product").id(1).aggregate(),
      /declares no \[AuditedRelation\]/,
    );
  });

  it("refuses a relation the model does not have", () => {
    const { audit } = reader();

    assert.throws(
      () => audit.for("Order").id(1).aggregate("items"),
      /no relation called "items"/,
    );
  });
});
