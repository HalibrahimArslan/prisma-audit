#!/usr/bin/env node
import process from "node:process";

import { AuditSchemaError } from "../parser/index.js";
import { describeResult, runGenerate } from "./generate.js";
import { describeTriggers, runTriggers } from "./triggers.js";

const USAGE = `prisma-audit — Envers-style auditing for Prisma

Usage:
  prisma-audit generate [options]   Write the Prisma-ready schema and metadata
  prisma-audit triggers [options]   Write the SQL that enforces auditing below
                                    the application

Options:
  --schema <path>   Annotated schema to read   (default: prisma/schema.prisma)
  --out <dir|file>  Where to write             (generate: <schema dir>/.audit)
  --triggers        generate: treat every [Auditable] model as [AuditTriggers]
  --drop            triggers: remove the triggers instead of installing them
  -h, --help        Show this message

The generated directory holds the Prisma-ready schema, the audit models and
audit.metadata.json. Point Prisma at it, for example in prisma.config.ts:

  export default defineConfig({ schema: "prisma/.audit" })

Triggers are ordinary SQL in an ordinary migration, because Prisma migrate does
not generate them and its drift detection cannot see them:

  prisma migrate dev --create-only --name audit_triggers
  prisma-audit triggers >> prisma/migrations/<timestamp>_audit_triggers/migration.sql
  prisma migrate dev

The SQL is idempotent and convergent, so re-running it after a schema change
replaces what the previous version installed rather than adding to it.
`;

/** Options that take the following argument as their value. */
const VALUE_FLAGS = new Set(["--schema", "--out"]);

interface Flags {
  schema?: string;
  out?: string;
  triggers?: boolean;
  drop?: boolean;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command !== "generate" && command !== "triggers") {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 1;
  }

  const flags = parseFlags(rest);
  const schema = flags.schema ?? "prisma/schema.prisma";

  reject(command, flags, command === "generate" ? "drop" : "triggers");

  if (command === "triggers") {
    const result = await runTriggers({
      schema,
      ...(flags.out === undefined ? {} : { out: flags.out }),
      ...(flags.drop === undefined ? {} : { drop: flags.drop }),
    });

    warn(result.warnings);

    if (result.written) {
      process.stderr.write(`${describeTriggers(result)}\nWrote ${result.written}\n`);
    } else {
      // The SQL goes to stdout so it composes with a redirect into a migration;
      // everything else is commentary and belongs on stderr.
      process.stdout.write(result.sql);
      process.stderr.write(`${describeTriggers(result)}\n`);
    }

    return 0;
  }

  const outDir = flags.out ?? defaultOutDir(schema);
  const result = await runGenerate({
    schema,
    outDir,
    ...(flags.triggers === undefined ? {} : { triggers: flags.triggers }),
  });

  warn(result.warnings);
  process.stdout.write(`${describeResult(result)}\n`);
  process.stdout.write(`Wrote ${outDir}\n`);

  return 0;
}

function warn(warnings: string[]): void {
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
}

/** Refuse a flag that belongs to the other command, rather than ignoring it. */
function reject(command: string, flags: Flags, flag: "drop" | "triggers"): void {
  if (flags[flag] !== undefined) {
    throw new Error(`--${flag} is not an option of "${command}".`);
  }
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value.`);
      if (arg === "--schema") flags.schema = value;
      else flags.out = value;
      index++;
      continue;
    }

    if (arg === "--triggers") {
      flags.triggers = true;
      continue;
    }

    if (arg === "--drop") {
      flags.drop = true;
      continue;
    }

    throw new Error(`Unknown option "${arg}".`);
  }

  return flags;
}

function defaultOutDir(schemaPath: string): string {
  const separator = schemaPath.includes("/") ? "/" : "\\";
  const parts = schemaPath.split(separator);
  parts.pop();
  return [...parts, ".audit"].join(separator) || ".audit";
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof AuditSchemaError) {
      process.stderr.write(`error: ${error.message}\n`);
    } else {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
