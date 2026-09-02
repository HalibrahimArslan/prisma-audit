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
