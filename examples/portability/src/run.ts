/**
 * The same auditing, run against every database prisma-audit claims to
 * support.
 *
 * PostgreSQL has the demo; this exists for the two providers the generator was
 * only ever *assumed* to be portable to. For each one it writes a datasource
 * header onto the shared model file, preprocesses it, pushes the result into an
 * empty database, generates a client, and runs the same checks through it.
 *
 *   pnpm db:up && pnpm check            # every provider that answers
 *   pnpm check sqlite                   # just one
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { run } from "./checks.js";

const exec = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scratch = path.join(root, ".scratch");

interface Provider {
  /** As the `datasource` block spells it. */
  name: string;
  url: string;
  /** The driver adapter factory the generated client is handed. */
  adapter: (url: string) => Promise<AnyFactory>;
  /**
   * Empty the database before the schema is pushed into it, so `db push` is
   * asked to create the generated schema rather than to reconcile with one.
   */
  reset: (url: string, adapter: AnyFactory) => Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFactory = any;

/**
 * Run DDL through the same driver adapter the client uses, rather than pulling
 * in a second copy of each database driver just to reset a database.
 *
 * One statement per call: `executeScript` is optional on a driver adapter and
 * the MariaDB one does not implement it.
 */
async function script(adapter: AnyFactory, ...statements: string[]): Promise<void> {
  const connection = await adapter.connect();
  try {
    for (const sql of statements) {
      await connection.executeRaw({ sql, args: [], argTypes: [] });
    }
  } finally {
    await connection.dispose();
  }
}

const PROVIDERS: Provider[] = [
  {
    name: "sqlite",
    url: `file:${path.join(scratch, "portability.db")}`,
    adapter: async (url) => {
      const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
      return new PrismaBetterSqlite3({ url });
    },
    // An empty file is an empty database, and deleting it is the one reset
    // that needs no server to be running.
    reset: async (url) => fs.rm(url.replace(/^file:/, ""), { force: true }),
  },
  {
    name: "mysql",
    url: process.env.MYSQL_URL ?? "mysql://root:audit@127.0.0.1:33306/audit",
    adapter: async (url) => {
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
      return new PrismaMariaDb(url);
    },
    reset: async (url, adapter) => {
      // MySQL lets a connection drop the database it is using; the next one
      // opens against the database this statement recreates.
      const database = new URL(url).pathname.replace(/^\//, "");
      await script(
        adapter,
        `DROP DATABASE IF EXISTS \`${database}\``,
        `CREATE DATABASE \`${database}\``,
      );
    },
  },
  {
    name: "postgresql",
    url:
      process.env.POSTGRES_URL ??
      // Port 55433: the demo's database is on 55432 and these checks empty
      // every schema they are pointed at.
      "postgresql://audit:audit@localhost:55433/audit?schema=public",
    adapter: async (url) => {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      return new PrismaPg({ connectionString: url });
    },
    // The schema is emptied rather than the database dropped: a connection may
    // not drop the database it is connected to.
    reset: async (_url, adapter) =>
      script(adapter, "DROP SCHEMA public CASCADE", "CREATE SCHEMA public"),
  },
];

/** The datasource and generator blocks that turn the shared models into a schema. */
function header(provider: string, outDir: string): string {
  return `// Written by src/run.ts. The models below are prisma/models.prisma.

generator client {
  provider = "prisma-client"
  output   = "${outDir}"
}

datasource db {
  provider = "${provider}"
}

`;
}

async function prepare(provider: Provider): Promise<string> {
  const dir = path.join(scratch, provider.name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const models = await fs.readFile(path.join(root, "prisma", "models.prisma"), "utf8");
  const annotated = path.join(dir, "schema.prisma");
  const client = path.join(dir, "client");

  await fs.writeFile(annotated, header(provider.name, client) + models, "utf8");

  // The package's own CLI, on the schema just written.
  await exec("pnpm", ["exec", "prisma-audit", "generate", "--schema", annotated], { cwd: root });

  const generated = path.join(dir, ".audit");

  await provider.reset(provider.url, await provider.adapter(provider.url));

  // db push rather than migrate: what is being checked is the schema the
  // generator produces, not a migration history kept per provider.
  await exec(
    "pnpm",
    ["exec", "prisma", "db", "push", "--schema", generated, "--url", provider.url],
    { cwd: root },
  );
  await exec(
    "pnpm",
    ["exec", "prisma", "generate", "--schema", generated],
    { cwd: root },
  );

  return dir;
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const providers = PROVIDERS.filter(
    (provider) => wanted.length === 0 || wanted.includes(provider.name),
  );

  if (providers.length === 0) {
    throw new Error(`Unknown provider. Known: ${PROVIDERS.map((p) => p.name).join(", ")}.`);
  }

  let failed = 0;

  for (const provider of providers) {
    console.log(`\n── ${provider.name} ${"─".repeat(Math.max(0, 50 - provider.name.length))}`);

    let dir: string;
    try {
      dir = await prepare(provider);
    } catch (error) {
      failed++;
      console.log(`  ✗ could not prepare the database`);
      console.log(`    ${message(error)}`);
      continue;
    }

    const { PrismaClient } = (await import(
      path.join(dir, "client", "client.js")
    )) as { PrismaClient: new (options: { adapter: unknown }) => unknown };

    const adapter = await provider.adapter(provider.url);
    const client = new PrismaClient({ adapter });

    failed += await run(client, path.join(dir, ".audit", "audit.metadata.json"));
  }

  if (failed > 0) process.exitCode = 1;
}

function message(error: unknown): string {
  if (error instanceof Error) {
    const output = error as Error & { stderr?: string; stdout?: string };
    return (output.stderr ?? output.stdout ?? output.message).trim().split("\n").slice(-6).join("\n    ");
  }
  return String(error);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
