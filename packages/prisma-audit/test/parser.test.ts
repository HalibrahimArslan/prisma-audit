import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AuditSchemaError, parseSchemaText } from "../src/parser/index.js";

const SCHEMA = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Currency {
  TRY
  USD
}

[Auditable]
model Product {
  id           Int      @id @default(autoincrement())
  name         String
  price        Decimal
  currency     Currency @default(TRY)

  [NotAudited]
  internalCode String?

  tags         String[]
  category     Category? @relation(fields: [categoryId], references: [id])
  categoryId   Int?

  createdAt    DateTime @default(now())

  [NotAudited]
  updatedAt    DateTime @updatedAt
}

model Category {
  id       Int       @id @default(autoincrement())
  name     String
  products Product[]
}
`;

describe("parser", () => {
  const result = parseSchemaText(SCHEMA);
  const product = result.metadata.models.find((model) => model.name === "Product");
  const category = result.metadata.models.find((model) => model.name === "Category");
  const field = (name: string) => product?.fields.find((f) => f.name === name);

  it("marks only annotated models as auditable", () => {
    assert.equal(product?.auditable, true);
    assert.equal(category?.auditable, false);
  });

  it("derives audit model, table and delegate names", () => {
    assert.equal(product?.auditModelName, "ProductAud");
    assert.equal(product?.auditTableName, "product_aud");
    assert.equal(product?.delegate, "product");
    assert.equal(product?.auditDelegate, "productAud");
  });

  it("finds the single-column primary key", () => {
    assert.deepEqual(product?.primaryKey, ["id"]);
    assert.equal(field("id")?.isId, true);
  });

  it("excludes fields marked [NotAudited]", () => {
    assert.equal(field("internalCode")?.audited, false);
    assert.equal(field("internalCode")?.excludedBy, "annotation");
    assert.equal(field("updatedAt")?.audited, false);
  });

  it("audits enum columns but not relations or lists", () => {
    assert.equal(field("currency")?.kind, "enum");
    assert.equal(field("currency")?.audited, true);

    assert.equal(field("category")?.kind, "relation");
    assert.equal(field("category")?.audited, false);
    assert.equal(field("category")?.excludedBy, "relation");

    assert.equal(field("tags")?.audited, false);
    assert.equal(field("tags")?.excludedBy, "list");
  });

  it("keeps the scalar foreign key of a relation", () => {
    assert.equal(field("categoryId")?.kind, "scalar");
    assert.equal(field("categoryId")?.audited, true);
  });

  it("strips annotations from the clean schema", () => {
    assert.ok(!result.cleanSchema.includes("[Auditable]"));
    assert.ok(!result.cleanSchema.includes("[NotAudited]"));
    assert.ok(result.cleanSchema.includes("model Product {"));
  });

  it("keeps line numbers stable so Prisma errors match the source", () => {
    assert.equal(result.cleanSchema.split("\n").length, SCHEMA.split("\n").length);
  });

  it("accepts an annotation written at the end of a field line", () => {
    const parsed = parseSchemaText(
      "[Auditable]\nmodel A {\n  id Int @id\n  secret String [NotAudited]\n}\n",
    );
    const secret = parsed.metadata.models[0]?.fields.find((f) => f.name === "secret");
    assert.equal(secret?.audited, false);
    assert.ok(!parsed.cleanSchema.includes("[NotAudited]"));
  });

  it("does not mistake a list type for an annotation", () => {
    const parsed = parseSchemaText("[Auditable]\nmodel A {\n  id Int @id\n  tags String[]\n}\n");
    assert.equal(parsed.metadata.models[0]?.fields.length, 2);
  });

  it("warns about an unknown annotation instead of failing", () => {
    const parsed = parseSchemaText("[Wat]\nmodel A {\n  id Int @id\n}\n");
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0] as string, /\[Wat\]/);
    assert.equal(parsed.metadata.models[0]?.auditable, false);
  });

  it("names the audit model, and derives the table, from [AuditTable(Name)]", () => {
    const { metadata } = parseSchemaText(
      "[Auditable]\n[AuditTable(ProductHistory)]\nmodel Product {\n  id Int @id\n}\n",
    );

    const product = metadata.models[0];
    assert.equal(product?.auditModelName, "ProductHistory");
    assert.equal(product?.auditTableName, "product_history");
    assert.equal(product?.auditDelegate, "productHistory");
    // The source model is untouched.
    assert.equal(product?.delegate, "product");
  });

  it("renames only the table when [AuditTable] is given a quoted name", () => {
    const { metadata } = parseSchemaText(
      '[AuditTable("product_hist")]\n[Auditable]\nmodel Product {\n  id Int @id\n}\n',
    );

    const product = metadata.models[0];
    assert.equal(product?.auditModelName, "ProductAud");
    assert.equal(product?.auditTableName, "product_hist");
  });

  it("rejects [AuditTable] on a model that is not [Auditable]", () => {
    assert.throws(
      () => parseSchemaText("[AuditTable(H)]\nmodel Product {\n  id Int @id\n}\n"),
      /does nothing without \[Auditable\]/,
    );
  });

  it("rejects [AuditTable] without a name", () => {
    assert.throws(
      () =>
        parseSchemaText("[Auditable]\n[AuditTable]\nmodel Product {\n  id Int @id\n}\n"),
      /needs a name/,
    );
  });

  it("rejects an audit name the schema already declares", () => {
    assert.throws(
      () =>
        parseSchemaText(
          "[Auditable]\n[AuditTable(Archive)]\nmodel Product {\n  id Int @id\n}\nmodel Archive {\n  id Int @id\n}\n",
        ),
      /already declares on line 6/,
    );
  });

  it("rejects two models that would share one audit table", () => {
    assert.throws(
      () =>
        parseSchemaText(
          '[Auditable]\n[AuditTable("history")]\nmodel A {\n  id Int @id\n}\n[Auditable]\n[AuditTable("history")]\nmodel B {\n  id Int @id\n}\n',
        ),
      /would both use the audit table history/,
    );
  });

  it("rejects a model that collides with the generated Revision", () => {
    assert.throws(
      () => parseSchemaText("model Revision {\n  id Int @id\n}\n"),
      /collides with the model prisma-audit generates/,
    );
  });

  it("rejects an enum that collides with the generated RevisionType", () => {
    assert.throws(
      () => parseSchemaText("enum RevisionType {\n  A\n}\n"),
      /collides with the enum prisma-audit generates/,
    );
  });

  it("rejects [NotAudited] written above a model", () => {
    assert.throws(
      () => parseSchemaText("[NotAudited]\nmodel A {\n  id Int @id\n}\n"),
      /can only be placed on a field/,
    );
  });

  it("rejects [Auditable] written above a field", () => {
    assert.throws(
      () => parseSchemaText("model A {\n  [Auditable]\n  id Int @id\n}\n"),
      /can only be placed on a model/,
    );
  });

  it("rejects an auditable model without a primary key", () => {
    assert.throws(
      () => parseSchemaText("[Auditable]\nmodel A {\n  name String\n}\n"),
      AuditSchemaError,
    );
  });

  it("reads a composite primary key in the order @@id gives it", () => {
    const { metadata } = parseSchemaText(
      "[Auditable]\nmodel A {\n  b Int\n  a Int\n  @@id([a, b])\n}\n",
    );

    assert.deepEqual(metadata.models[0]?.primaryKey, ["a", "b"]);
    assert.equal(metadata.models[0]?.primaryKeyName, undefined);
  });

  it("keeps the name @@id gives a composite key, and drops column modifiers", () => {
    const { metadata } = parseSchemaText(
      '[Auditable]\nmodel A {\n  a String\n  b Int\n  @@id([a(length: 100), b], name: "ab")\n}\n',
    );

    assert.deepEqual(metadata.models[0]?.primaryKey, ["a", "b"]);
    assert.equal(metadata.models[0]?.primaryKeyName, "ab");
  });

  it("lets @@id override a field-level @id wherever it is written", () => {
    const { metadata } = parseSchemaText(
      "[Auditable]\nmodel A {\n  a Int @id\n  b Int\n  @@id([a, b])\n}\n",
    );

    assert.deepEqual(metadata.models[0]?.primaryKey, ["a", "b"]);
  });

  it("rejects a composite key naming a field the model does not have", () => {
    assert.throws(
      () => parseSchemaText("[Auditable]\nmodel A {\n  a Int\n  @@id([a, b])\n}\n"),
      /no field "b"/,
    );
  });

  it("rejects a composite key that includes a relation field", () => {
    assert.throws(
      () =>
        parseSchemaText(
          "[Auditable]\nmodel A {\n  bId Int\n  b B @relation(fields: [bId], references: [id])\n  @@id([bId, b])\n}\nmodel B {\n  id Int @id\n}\n",
        ),
      /relation field/,
    );
  });

  it("rejects [NotAudited] on part of a composite key", () => {
    assert.throws(
      () =>
        parseSchemaText(
          "[Auditable]\nmodel A {\n  a Int\n  [NotAudited]\n  b Int\n  @@id([a, b])\n}\n",
        ),
      /cannot be \[NotAudited\]/,
    );
  });

  it("rejects [NotAudited] on the primary key", () => {
    assert.throws(
      () => parseSchemaText("[Auditable]\nmodel A {\n  [NotAudited]\n  id Int @id\n}\n"),
      /primary key/,
    );
  });

  it("rejects a field that collides with a generated audit column", () => {
    assert.throws(
      () =>
        parseSchemaText("[Auditable]\nmodel A {\n  id Int @id\n  revType String\n}\n"),
      /collides/,
    );
  });

  it("rejects an annotation that is not attached to a declaration", () => {
    assert.throws(
      () => parseSchemaText("[Auditable]\n\nmodel A {\n  id Int @id\n}\n"),
      /must be followed by/,
    );
  });
});
