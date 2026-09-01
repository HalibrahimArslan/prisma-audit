import process from "node:process";

import { PrismaPg } from "@prisma/adapter-pg";
import { loadMetadata, withAudit } from "prisma-audit";

import { PrismaClient } from "./generated/prisma/client.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // Fine when DATABASE_URL is already exported.
}

/**
 * The acting user is application state, not database state, so prisma-audit
 * asks for it instead of guessing. In a web app this would read from the
 * request context; here a module-level variable stands in for that.
 */
let currentUser: { userId: string; username: string } | undefined;

export function setCurrentUser(user: typeof currentUser): void {
  currentUser = user;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = withAudit(new PrismaClient({ adapter }), {
  metadata: loadMetadata(
    new URL("../prisma/.audit/audit.metadata.json", import.meta.url).pathname,
  ),
  userProvider: () => currentUser,
});
