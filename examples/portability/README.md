# Portability checks

The same auditing, run against every database prisma-audit claims to support.

PostgreSQL has [the demo](../demo), which walks through the feature set and
includes the trigger work that is PostgreSQL-only. This example exists for the
opposite question: is the *generated* schema — `Revision`, the `RevisionType`
enum, the audit tables and their composite keys — one that MySQL and SQLite
accept, and does the runtime behave the same through all three?

```bash
pnpm install
pnpm build                      # the checks run against the package's dist

cd examples/portability
pnpm db:up                      # MySQL on 33306, PostgreSQL on 55433
pnpm check                      # every provider
pnpm check sqlite               # just one; SQLite needs no container at all
```

For each provider, `src/run.ts` writes a datasource and generator header onto
the shared `prisma/models.prisma`, runs `prisma-audit generate` on the result,
empties the database, pushes the generated schema into it with `prisma db push`,
generates a client, and hands that client to the checks in `src/checks.ts`.
Nothing is committed per provider: the whole scratch tree is rebuilt each run.

`db push` rather than `migrate`: what is being asked is whether the generated
schema is one the database will create, not whether a migration history can be
kept for it.

## What this has caught

- **The revision key.** It was a `BigInt`, which SQLite cannot autoincrement —
  SQLite gives a column autoincrement by making it an alias of the table's
  rowid, and only a column declared exactly `INTEGER` qualifies. Every insert
  into `revision` failed on a NOT NULL id. The key is an `Int` on SQLite now.
- **`createMany`.** The runtime chose between inserting-and-returning and
  replaying row by row by asking the delegate whether it had
  `createManyAndReturn`. The generated client has that method on every
  database and only refuses the call once it has been made, so MySQL took the
  fast path and failed. The provider decides now.

## A note on MySQL

Prisma's driver adapter for the `mysql` provider is the MariaDB connector,
which cannot authenticate against MySQL 8's default `caching_sha2_password`.
The compose file starts the server with the older plugin loaded and hands its
two users over to it, which is a fact about connecting to MySQL from Node
rather than anything to do with auditing.
