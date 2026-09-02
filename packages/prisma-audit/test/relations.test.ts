import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSchemaText } from "../src/parser/index.js";
import { resolveRelationLink } from "../src/util/relations.js";

/** Resolve `Model.field` against the schema, the way a nested write does. */
function link(schema: string, modelName: string, fieldName: string) {
  const { metadata } = parseSchemaText(schema);

  const model = metadata.models.find((candidate) => candidate.name === modelName);
  const field = model?.fields.find((candidate) => candidate.name === fieldName);
  const target = metadata.models.find((candidate) => candidate.name === field?.type);

  assert.ok(model && field && target, `${modelName}.${fieldName} is not in the schema`);
  return resolveRelationLink(field, model, target);
}

const ONE_TO_MANY = `[Auditable]
model Product {
  id     Int     @id
  stocks Stock[]
}

[Auditable]
model Stock {
  id        Int     @id
  productId Int
  product   Product @relation(fields: [productId], references: [id])
}
`;

describe("resolveRelationLink", () => {
  it("finds the foreign key on the child of a one-to-many", () => {
    assert.deepEqual(link(ONE_TO_MANY, "Product", "stocks"), {
      kind: "child-owns",
      columns: [{ parent: "id", child: "productId" }],
    });
  });

  it("reads the foreign key off the model that declares it", () => {
    assert.deepEqual(link(ONE_TO_MANY, "Stock", "product"), {
      kind: "parent-owns",
      columns: [{ parent: "productId", child: "id" }],
    });
  });

  it("joins on every column of a composite foreign key", () => {
    const schema = `[Auditable]
model Order {
  tenantId Int
  number   Int
  lines    OrderLine[]

  @@id([tenantId, number])
}

[Auditable]
model OrderLine {
  id          Int   @id
  tenantId    Int
  orderNumber Int
  order       Order @relation(fields: [tenantId, orderNumber], references: [tenantId, number])
}
`;

    assert.deepEqual(link(schema, "Order", "lines"), {
      kind: "child-owns",
      columns: [
        { parent: "tenantId", child: "tenantId" },
        { parent: "number", child: "orderNumber" },
      ],
    });
  });

  it("follows a self-relation, whose two sides sit on one model", () => {
    const schema = `[Auditable]
model Category {
  id       Int        @id
  parentId Int?
  parent   Category?  @relation("Tree", fields: [parentId], references: [id])
  children Category[] @relation("Tree")
}
`;

    assert.deepEqual(link(schema, "Category", "children"), {
      kind: "child-owns",
      columns: [{ parent: "id", child: "parentId" }],
    });
  });

  it("tells two relations to one model apart by their names", () => {
    const schema = `[Auditable]
model User {
  id      Int    @id
  written Post[] @relation("author")
  edited  Post[] @relation("editor")
}

[Auditable]
model Post {
  id       Int  @id
  authorId Int
  editorId Int
  author   User @relation("author", fields: [authorId], references: [id])
  editor   User @relation("editor", fields: [editorId], references: [id])
}
`;

    assert.deepEqual(link(schema, "User", "written"), {
      kind: "child-owns",
      columns: [{ parent: "id", child: "authorId" }],
    });
    assert.deepEqual(link(schema, "User", "edited"), {
      kind: "child-owns",
      columns: [{ parent: "id", child: "editorId" }],
    });
  });

  it("gives up on an implicit many-to-many, which names no join columns", () => {
    const schema = `[Auditable]
model Product {
  id   Int   @id
  tags Tag[]
}

[Auditable]
model Tag {
  id       Int       @id
  products Product[]
}
`;

    assert.equal(link(schema, "Product", "tags"), null);
  });
});
