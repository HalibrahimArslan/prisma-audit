import process from "node:process";

import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env implicitly.
try {
  process.loadEnvFile(new URL(".env", import.meta.url).pathname);
} catch {
  // Fine when the variables are already exported in the environment.
}

/**
 * Prisma never reads prisma/schema.prisma directly: that file carries the
 * prisma-audit annotations and is not valid Prisma. `prisma-audit generate`
 * writes the Prisma-ready schema plus the audit models into prisma/.audit,
 * and Prisma reads that directory as a multi-file schema.
 *
 * Migrations deliberately stay in prisma/migrations, which is committed, while
 * prisma/.audit is generated and git-ignored.
 */
export default defineConfig({
  schema: "prisma/.audit",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
