import fs from "node:fs";
import path from "node:path";

import { METADATA_VERSION, type AuditMetadata } from "../metadata.js";

const DEFAULT_PATH = "prisma/.audit/audit.metadata.json";

/**
 * Load the metadata that `prisma-audit generate` wrote.
 *
 * Reading it from disk rather than re-parsing `schema.prisma` keeps schema
 * parsing out of the application's start-up path, and keeps the runtime honest:
 * if the metadata is stale relative to the database, `prisma migrate` will have
 * said so first.
 */
export function loadMetadata(metadataPath: string = DEFAULT_PATH): AuditMetadata {
  const resolved = path.resolve(metadataPath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(
      `Could not read audit metadata at ${resolved}. Run "prisma-audit generate" first.`,
    );
  }

  const metadata = JSON.parse(raw) as AuditMetadata;

  if (metadata.version > METADATA_VERSION) {
    throw new Error(
      `Audit metadata at ${resolved} has version ${String(metadata.version)}, which is newer ` +
        `than the version ${METADATA_VERSION} this build of prisma-audit understands. Upgrade prisma-audit.`,
    );
  }

  return metadata.version < METADATA_VERSION ? upgrade(metadata) : metadata;
}

/**
 * Bring an older metadata file up to the current shape, in memory.
 *
 * An application keeps starting after a prisma-audit upgrade; the file itself is
 * rewritten by the next `prisma-audit generate`. What can be derived is derived:
 * version 1 recorded a model's primary key as a single column name, which is a
 * key of one column. What cannot is left absent — version 2 knows nothing about
 * how relations join, so a nested write is reported as unauditable until the
 * metadata is regenerated, which is what it would do for an unfollowable
 * relation anyway.
 *
 * Version 5 needs no code at all. It added the physical table and column names,
 * and `tableNameOf` / `columnNameOf` fall back to Prisma's own defaults, which
 * is exactly right for the schemas an older file could describe: the parser did
 * not read `@@map` before version 5, so no such file can be carrying a mapped
 * name that the fallback would get wrong. Version 5 also added `triggers`, and
 * absent reads as off — the safe direction, since a stale file leaves the
 * runtime writing the audit rows itself rather than quietly recording nothing.
 * The other direction, triggers installed while the metadata says otherwise,
 * fails loudly on a duplicate audit row and rolls the write back.
 */
function upgrade(metadata: AuditMetadata): AuditMetadata {
  if (metadata.version < 2) {
    for (const model of metadata.models) {
      const legacy = model.primaryKey as unknown as string | null;
      model.primaryKey = typeof legacy === "string" ? [legacy] : [];
    }
  }

  metadata.version = METADATA_VERSION;
  return metadata;
}
