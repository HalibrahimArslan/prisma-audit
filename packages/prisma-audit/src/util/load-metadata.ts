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

  if (metadata.version === 1) return upgradeFromVersion1(metadata);

  if (metadata.version !== METADATA_VERSION) {
    throw new Error(
      `Audit metadata at ${resolved} has version ${String(metadata.version)}, but this ` +
        `version of prisma-audit expects version ${METADATA_VERSION}. Re-run "prisma-audit generate".`,
    );
  }

  return metadata;
}

/**
 * Version 1 recorded a model's primary key as a single column name, because a
 * composite key was rejected at parse time. Version 2 records the columns that
 * make up the key, which reads the same for every schema version 1 accepted.
 *
 * Upgrading in memory means an application keeps starting after a prisma-audit
 * upgrade; the file itself is rewritten by the next `prisma-audit generate`.
 */
function upgradeFromVersion1(metadata: AuditMetadata): AuditMetadata {
  for (const model of metadata.models) {
    const legacy = model.primaryKey as unknown as string | null;
    model.primaryKey = typeof legacy === "string" ? [legacy] : [];
  }

  metadata.version = METADATA_VERSION;
  return metadata;
}
