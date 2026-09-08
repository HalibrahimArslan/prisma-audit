import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  METADATA_VERSION,
  columnNameOf,
  tableNameOf,
  triggerBackedModels,
  type AuditMetadata,
} from "../src/metadata.js";
import { loadMetadata } from "../src/util/load-metadata.js";

/** Write a metadata file into a throwaway directory and return its path. */
function write(metadata: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-audit-"));
  const file = path.join(dir, "audit.metadata.json");
  fs.writeFileSync(file, JSON.stringify(metadata), "utf8");
  return file;
}

/** A model as version 4 wrote one: no physical names, no triggers flag. */
function version4(): unknown {
  return {
    version: 4,
    enums: [],
    provider: "postgresql",
    models: [
      {
        name: "Product",
        auditable: true,
        auditModelName: "ProductAud",
        auditTableName: "product_aud",
        delegate: "product",
        auditDelegate: "productAud",
        primaryKey: ["id"],
        line: 1,
        fields: [
          {
            name: "id",
            type: "Int",
            kind: "scalar",
            isList: false,
            isOptional: false,
            isId: true,
            attributes: "@id",
            audited: true,
            line: 2,
          },
        ],
      },
    ],
  };
}

describe("loadMetadata", () => {
  it("refuses a file newer than the build reading it", () => {
    const file = write({ version: METADATA_VERSION + 1, models: [], enums: [] });

    assert.throws(() => loadMetadata(file), /newer than the version/);
  });

  it("names the command to run when the file is not there", () => {
    assert.throws(
      () => loadMetadata(path.join(os.tmpdir(), "prisma-audit-absent", "audit.metadata.json")),
      /prisma-audit generate/,
    );
  });

  it("widens a version 1 primary key into the list of columns that form it", () => {
    const legacy = version4() as AuditMetadata;
    legacy.version = 1;
    (legacy.models[0] as unknown as { primaryKey: string }).primaryKey = "id";

    const metadata = loadMetadata(write(legacy));

    assert.deepEqual(metadata.models[0]?.primaryKey, ["id"]);
    assert.equal(metadata.version, METADATA_VERSION);
  });

  it("stamps the current version onto an older file", () => {
    const metadata = loadMetadata(write(version4()));

    assert.equal(metadata.version, METADATA_VERSION);
  });
});

describe("physical name accessors", () => {
  it("fall back to Prisma's defaults for a file written before version 5", () => {
    const metadata = loadMetadata(write(version4()));
    const model = metadata.models[0];

    assert.equal(model?.tableName, undefined);
    assert.equal(tableNameOf(model as never), "Product");
    assert.equal(columnNameOf(model?.fields[0] as never), "id");
  });

  it("prefer the mapped names when the file carries them", () => {
    const metadata = loadMetadata(write(version4()));
    const model = metadata.models[0] as never as { tableName: string; fields: [{ columnName: string }] };

    model.tableName = "products";
    model.fields[0].columnName = "product_id";

    assert.equal(tableNameOf(model as never), "products");
    assert.equal(columnNameOf(model.fields[0] as never), "product_id");
  });
});

describe("triggerBackedModels", () => {
  it("reads an absent flag as off, so a stale file keeps the runtime writing", () => {
    const metadata = loadMetadata(write(version4()));

    assert.deepEqual(triggerBackedModels(metadata), []);
  });

  it("lists the models a trigger writes for", () => {
    const file = version4() as AuditMetadata;
    (file.models[0] as { triggers?: boolean }).triggers = true;

    assert.deepEqual(
      triggerBackedModels(loadMetadata(write(file))).map((model) => model.name),
      ["Product"],
    );
  });

  it("leaves out a model that is trigger-backed but not auditable", () => {
    const file = version4() as AuditMetadata;
    (file.models[0] as { triggers?: boolean }).triggers = true;
    (file.models[0] as { auditable: boolean }).auditable = false;

    assert.deepEqual(triggerBackedModels(loadMetadata(write(file))), []);
  });
});
