import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateAuditSchema } from "../src/generator/index.js";
import { rebaseRelativePaths } from "../src/generator/rebase.js";
import { parseSchemaText } from "../src/parser/index.js";

const SCHEMA = `enum Currency {
  TRY
  USD
}

[Auditable]
model Product {
  id           Int      @id @default(autoincrement())
  name         String   @db.VarChar(200)
  price        Decimal
  currency     Currency @default(TRY)
  sku          String   @unique

  [NotAudited]
  internalCode String?

  categoryId   Int?
  category     Category? @relation(fields: [categoryId], references: [id])

  createdAt    DateTime @default(now())

  [NotAudited]
  updatedAt    DateTime @updatedAt
}

[Auditable]
model OrderLine {
  id       Int    @id @default(autoincrement())
  quantity Int
}

model Category {
  id       Int       @id @default(autoincrement())
  name     String
  products Product[]
}
`;

describe("generator", () => {
  const { metadata } = parseSchemaText(SCHEMA);
  const output = generateAuditSchema(metadata);

  it("emits the RevisionType enum", () => {
    assert.match(output, /enum RevisionType \{\n {2}INSERT\n {2}UPDATE\n {2}DELETE\n\}/);
  });

  it("emits a Revision model with no operation column", () => {
    const revision = block(output, "Revision");
    assert.match(revision, /id\s+BigInt\s+@id @default\(autoincrement\(\)\)/);
    assert.match(revision, /timestamp DateTime @default\(now\(\)\)/);
    assert.match(revision, /userId\s+String\?/);
    // The operation lives on the audit row: one revision can hold several.
    assert.ok(!/revType/.test(revision));
  });

  it("adds a back-relation on Revision for every audit model", () => {
    const revision = block(output, "Revision");
    assert.match(revision, /productAud\s+ProductAud\[\]/);
    assert.match(revision, /orderLineAud\s+OrderLineAud\[\]/);
  });

  it("generates one audit model per [Auditable] model only", () => {
    assert.match(output, /model ProductAud \{/);
    assert.match(output, /model OrderLineAud \{/);
    assert.ok(!/model CategoryAud/.test(output));
  });

  it("maps audit models to snake_case tables", () => {
    assert.match(output, /@@map\("product_aud"\)/);
    assert.match(output, /@@map\("order_line_aud"\)/);
  });

  it("omits excluded, relation and list fields", () => {
    const product = block(output, "ProductAud");
    assert.ok(!/internalCode/.test(product));
    assert.ok(!/updatedAt/.test(product));
    assert.ok(!/\bcategory\b/.test(product));
    // The scalar foreign key is a normal column and is kept.
    assert.match(product, /categoryId\s+Int\?/);
  });

  it("keeps enum columns", () => {
    assert.match(block(output, "ProductAud"), /currency\s+Currency\?/);
  });

  it("keeps the primary key required and everything else optional", () => {
    const product = block(output, "ProductAud");
    assert.match(product, /^\s+id\s+Int$/m);
    assert.match(product, /name\s+String\?/);
    assert.match(product, /price\s+Decimal\?/);
  });

  it("drops identity, uniqueness and default attributes but keeps @db types", () => {
    const product = block(output, "ProductAud");
    assert.ok(!/@id @default/.test(product));
    assert.ok(!/@unique/.test(product));
    assert.ok(!/@default\(TRY\)/.test(product));
    assert.match(product, /name\s+String\? @db\.VarChar\(200\)/);
  });

  it("keys audit rows by revision plus primary key and indexes the lookup path", () => {
    const product = block(output, "ProductAud");
    assert.match(product, /@@id\(\[revisionId, id\]\)/);
    assert.match(product, /@@index\(\[id, revisionId\]\)/);
    assert.match(product, /@@index\(\[revisionId\]\)/);
  });

  it("cascades audit rows when a revision is deleted", () => {
    assert.match(block(output, "ProductAud"), /onDelete: Cascade/);
  });

  it("produces nothing but the revision scaffolding when no model is annotated", () => {
    const { metadata: empty } = parseSchemaText("model A {\n  id Int @id\n}\n");
    const emptyOutput = generateAuditSchema(empty);
    assert.match(emptyOutput, /model Revision \{/);
    assert.ok(!/Aud \{/.test(emptyOutput));
  });
});

describe("rebaseRelativePaths", () => {
  const schema = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

  it("rewrites a relative generator output for the deeper directory", () => {
    const out = rebaseRelativePaths(schema, "/app/prisma", "/app/prisma/.audit");
    assert.match(out, /output {3}= "\.\.\/\.\.\/src\/generated\/prisma"/);
  });

  it("leaves absolute paths and env() alone", () => {
    const out = rebaseRelativePaths(
      'generator client {\n  output = "/abs/path"\n}\n',
      "/app/prisma",
      "/app/prisma/.audit",
    );
    assert.match(out, /output = "\/abs\/path"/);
    assert.match(rebaseRelativePaths(schema, "/a", "/a/.audit"), /env\("DATABASE_URL"\)/);
  });

  it("is a no-op when the directories are the same", () => {
    assert.equal(rebaseRelativePaths(schema, "/app/prisma", "/app/prisma"), schema);
  });

  it("only touches output inside generator blocks", () => {
    const withDatasource = 'datasource db {\n  output = "../x"\n}\n';
    assert.equal(
      rebaseRelativePaths(withDatasource, "/app/prisma", "/app/prisma/.audit"),
      withDatasource,
    );
  });
});

/** Extract a single `model X { ... }` block from generated output. */
function block(schema: string, name: string): string {
  const match = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  assert.ok(match, `expected a model ${name} block in:\n${schema}`);
  return match[0];
}
