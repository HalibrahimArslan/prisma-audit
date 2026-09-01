import fs from "node:fs";
import path from "node:path";

import type { AuditMetadata } from "../metadata.js";

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

  if (metadata.version !== 1) {
    throw new Error(
      `Audit metadata at ${resolved} has version ${String(metadata.version)}, but this ` +
        `version of prisma-audit expects version 1. Re-run "prisma-audit generate".`,
    );
  }

  return metadata;
}
