#!/usr/bin/env node
import process from "node:process";

import { AuditSchemaError } from "../parser/index.js";
import { describeResult, runGenerate } from "./generate.js";

const USAGE = `prisma-audit — Envers-style auditing for Prisma

Usage:
  prisma-audit generate [options]

Options:
  --schema <path>   Annotated schema to read   (default: prisma/schema.prisma)
  --out <dir>       Directory to write into    (default: <schema dir>/.audit)
  -h, --help        Show this message

The generated directory holds the Prisma-ready schema, the audit models and
audit.metadata.json. Point Prisma at it, for example in prisma.config.ts:

  export default defineConfig({ schema: "prisma/.audit" })
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command !== "generate") {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 1;
  }

  const flags = parseFlags(rest);
  const schema = flags.schema ?? "prisma/schema.prisma";
  const outDir = flags.out ?? defaultOutDir(schema);

  const result = await runGenerate({ schema, outDir });

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  process.stdout.write(`${describeResult(result)}\n`);
  process.stdout.write(`Wrote ${outDir}\n`);

  return 0;
}

function parseFlags(argv: string[]): { schema?: string; out?: string } {
  const flags: { schema?: string; out?: string } = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--schema" || arg === "--out") {
      if (!value) throw new Error(`${arg} needs a value.`);
      if (arg === "--schema") flags.schema = value;
      else flags.out = value;
      index++;
      continue;
    }

    throw new Error(`Unknown option "${String(arg)}".`);
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
