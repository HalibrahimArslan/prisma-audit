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
model OrderLine {
  orderId  Int
  lineNo   Int
  quantity Int

  @@id([orderId, lineNo])
}
`;

const { metadata } = parseSchemaText(SCHEMA);

type Row = Record<string, any>;

const REVISION = { timestamp: new Date("2026-01-01T00:00:00Z"), userId: "42", username: "halil" };

/** Matches the flat equality and `lte`/`gte` filters the reader itself builds. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];

    if (condition !== null && typeof condition === "object") {
      const filter = condition as Row;
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

function reader(productRows: Row[] = [], orderLineRows: Row[] = []) {
  const productAud = new FakeAuditTable(productRows);
  const orderLineAud = new FakeAuditTable(orderLineRows);

  const client: any = {
    productAud,
    orderLineAud,
    revision: {
      findMany: (args: any) => [
        {
          id: 1n,
          ...REVISION,
          ...(args.include.productAud ? { productAud: productRows } : {}),
          ...(args.include.orderLineAud ? { orderLineAud: orderLineRows } : {}),
        },
      ],
    },
  };

  return { audit: new AuditReader(client, metadata), productAud, orderLineAud };
}

describe("AuditQuery", () => {
  it("filters a single-column key by the value itself", async () => {
    const { audit, productAud } = reader([
      { revisionId: 1n, revType: "INSERT", id: 10, name: "a", price: 1 },
      { revisionId: 2n, revType: "UPDATE", id: 20, name: "b", price: 2 },
    ]);

    const history = await audit.for("Product").id(10).getRevisions();

    assert.deepEqual(productAud.queries[0], { id: 10 });
    assert.deepEqual(
      history.map((entry) => entry.entity),
      [{ id: 10, name: "a", price: 1 }],
    );
    assert.equal(history[0]?.user.username, "halil");
  });

  it("filters a composite key on every one of its columns", async () => {
    const { audit, orderLineAud } = reader(
      [],
      [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 2n, revType: "UPDATE", orderId: 1, lineNo: 2, quantity: 9 },
      ],
    );

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
    const { audit } = reader(
      [],
      [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 3n, revType: "DELETE", orderId: 1, lineNo: 1, quantity: 5 },
      ],
    );

    const line = audit.for("OrderLine").id({ orderId: 1, lineNo: 1 });

    assert.notEqual(await line.atRevision(2n), null);
    assert.equal(await line.atRevision(3n), null);
  });

  it("diffs a composite-key row across two revisions", async () => {
    const { audit } = reader(
      [],
      [
        { revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 1, quantity: 5 },
        { revisionId: 2n, revType: "UPDATE", orderId: 1, lineNo: 1, quantity: 8 },
      ],
    );

    const diff = await audit.for("OrderLine").id({ orderId: 1, lineNo: 1 }).diff(1n, 2n);

    assert.deepEqual(diff, { quantity: { old: 5, new: 8 } });
  });
});

describe("AuditReader.revisions", () => {
  it("reports a change under the key shape that .id() accepts", async () => {
    const { audit } = reader(
      [{ revisionId: 1n, revType: "UPDATE", id: 10, name: "a", price: 1 }],
      [{ revisionId: 1n, revType: "INSERT", orderId: 1, lineNo: 2, quantity: 5 }],
    );

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
