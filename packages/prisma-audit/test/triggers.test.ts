import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateTriggerSql, triggerFunctionName, TRIGGER_NAME } from "../src/generator/triggers.js";
import { parseSchemaText } from "../src/parser/index.js";

const SCHEMA = `datasource db {
  provider = "postgresql"
}

enum Currency {
  TRY
  USD
}

[Auditable]
[AuditTriggers]
model Product {
  id       Int      @id @default(autoincrement())
  name     String
  currency Currency @default(TRY)

  [NotAudited]
  internalCode String?

  createdAt DateTime @default(now())
}

[Auditable]
[AuditTriggers]
model OrderLine {
  orderId  Int
  lineNo   Int
  quantity Int

  @@id([orderId, lineNo])
}

[Auditable]
[AuditTriggers]
model Shipment {
  id         Int    @id
  trackingNo String @map("tracking_no")

  @@map("shipment")
}

[Auditable]
model Stock {
  id Int @id
}
`;

/** The generated SQL for a schema, defaulting to the fixture above. */
function sql(source: string = SCHEMA, drop = false): string {
  return generateTriggerSql(parseSchemaText(source).metadata, { drop });
}

/** How many times a fragment occurs in the generated SQL. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("generateTriggerSql", () => {
  it("emits the shared revision resolver exactly once", () => {
    assert.equal(count(sql(), 'CREATE OR REPLACE FUNCTION "prisma_audit_revision"()'), 1);
  });

  it("emits one function and one trigger per trigger-backed model", () => {
    const out = sql();

    assert.equal(count(out, "CREATE TRIGGER"), 3);
    assert.equal(count(out, "DROP TRIGGER IF EXISTS"), 3);
    // Three models plus the shared resolver.
    assert.equal(count(out, "CREATE OR REPLACE FUNCTION"), 4);
  });

  it("leaves an [Auditable] model without [AuditTriggers] alone", () => {
    const out = sql();

    assert.ok(!out.includes('ON "Stock"'));
    assert.ok(!out.includes("prisma_audit_stock_aud"));
  });

  it("names the trigger the same on every table, so it can be replaced", () => {
    const out = sql();

    assert.ok(out.includes(`DROP TRIGGER IF EXISTS "${TRIGGER_NAME}" ON "Product";`));
    assert.ok(out.includes(`CREATE TRIGGER "${TRIGGER_NAME}"`));
  });

  it("copies exactly the audited columns, in schema order", () => {
    const out = sql();

    assert.ok(
      out.includes('"revisionId", "revType", "id", "name", "currency", "createdAt"'),
    );
  });

  it("leaves a [NotAudited] column out of the audit row entirely", () => {
    assert.ok(!sql().includes("internalCode"));
  });

  it("writes the mapped table and column names the database actually has", () => {
    const out = sql();

    assert.ok(out.includes('ON "shipment"'));
    assert.ok(out.includes('row_state."tracking_no"'));
    assert.ok(out.includes('"tracking_no" = excluded."tracking_no"'));
    // The Prisma-side field name never reaches the SQL.
    assert.ok(!out.includes("trackingNo"));
  });

  it("takes the whole key as the conflict target", () => {
    assert.ok(sql().includes('ON CONFLICT ("revisionId", "orderId", "lineNo") DO UPDATE SET'));
  });

  it("leaves the key columns out of the assignments, being equal already", () => {
    const block = sql().slice(sql().indexOf('ON CONFLICT ("revisionId", "orderId", "lineNo")'));
    const assignments = block.slice(0, block.indexOf(";"));

    assert.ok(assignments.includes('"quantity" = excluded."quantity"'));
    assert.ok(!assignments.includes('"orderId" = excluded'));
    assert.ok(!assignments.includes('"lineNo" = excluded'));
  });

  it("keeps a row created and then changed in one revision an INSERT", () => {
    assert.ok(
      sql().includes(
        [
          '    "revType" = CASE',
          '                  WHEN "product_aud"."revType" = \'INSERT\'',
          "                   AND excluded.\"revType\" = 'UPDATE'",
          '                  THEN \'INSERT\'::"RevisionType"',
          '                  ELSE excluded."revType"',
          "                END,",
        ].join("\n"),
      ),
    );
  });

  it("reads the revision off the transaction and opens one when there is none", () => {
    const out = sql();

    assert.ok(out.includes("current_setting('prisma_audit.revision_id', true)"));
    assert.ok(out.includes('INSERT INTO "revision" ("userId", "username")'));
    assert.ok(out.includes("set_config('prisma_audit.revision_id', revision_id::text, true)"));
  });

  it("lets the runtime tell the trigger to stand down", () => {
    assert.ok(sql().includes("IF nullif(current_setting('prisma_audit.suppress', true), '') = 'on' THEN"));
  });

  it("reads OLD for a delete, since there is no NEW left", () => {
    const out = sql();

    assert.ok(out.includes("IF TG_OP = 'DELETE' THEN"));
    assert.ok(out.includes("row_state := OLD;"));
  });

  it("sweeps the tables the schema no longer names", () => {
    assert.ok(
      sql().includes("AND c.relname <> ALL (ARRAY['Product', 'OrderLine', 'shipment']::text[])"),
    );
  });

  it("keeps the functions it just wrote, and only those", () => {
    assert.ok(
      sql().includes(
        "AND p.proname <> ALL (ARRAY['prisma_audit_revision', 'prisma_audit_product_aud', 'prisma_audit_order_line_aud', 'prisma_audit_shipment_aud']::text[])",
      ),
    );
  });

  it("sweeps everything when no model is trigger-backed", () => {
    const out = sql('datasource db {\n  provider = "postgresql"\n}\n\n[Auditable]\nmodel Stock {\n  id Int @id\n}\n');

    assert.ok(!out.includes("CREATE TRIGGER"));
    assert.ok(out.includes("AND c.relname <> ALL (ARRAY[]::text[])"));
  });

  it("installs nothing under --drop, and removes what is there", () => {
    const out = sql(SCHEMA, true);

    assert.ok(!out.includes("CREATE TRIGGER"));
    assert.ok(!out.includes("CREATE OR REPLACE FUNCTION"));
    assert.ok(out.includes("DROP TRIGGER"));
    assert.ok(out.includes("DROP FUNCTION"));
  });

  it("names the function after the audit table", () => {
    const { metadata } = parseSchemaText(SCHEMA);
    const product = metadata.models.find((model) => model.name === "Product");

    assert.equal(triggerFunctionName(product as never), "prisma_audit_product_aud");
  });

  it("refuses a function name PostgreSQL would silently truncate", () => {
    const long = "a".repeat(55);

    assert.throws(
      () =>
        sql(
          `datasource db {\n  provider = "postgresql"\n}\n\n[Auditable]\n[AuditTable("${long}")]\n[AuditTriggers]\nmodel Product {\n  id Int @id\n}\n`,
        ),
      /identifier limit/,
    );
  });

  it("refuses metadata whose provider is not postgresql", () => {
    const { metadata } = parseSchemaText(SCHEMA);
    metadata.provider = "mysql";

    assert.throws(() => generateTriggerSql(metadata), /PostgreSQL-only/);
  });
});
