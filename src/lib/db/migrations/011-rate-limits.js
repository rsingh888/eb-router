import { TABLES, buildCreateTableSql } from "../schema.js";

export async function rateLimitsPostgres(adapter) {
  const { qExec } = await import("../query.js");
  for (const name of ["rateLimitWindows", "loginLockouts"]) {
    const def = TABLES[name];
    await qExec(adapter, buildCreateTableSql(name, def, "postgres"));
    for (const idx of def.indexes || []) {
      const pgIdx = idx.replace(/ ON (\w+)\(/g, (_, table) => ` ON "${table}"(`);
      try { await qExec(adapter, pgIdx); } catch {}
    }
  }
}

export default {
  version: 11,
  name: "rate-limits",
  up(db) {
    const dialect = db.dialect || "sqlite";
    for (const name of ["rateLimitWindows", "loginLockouts"]) {
      const def = TABLES[name];
      db.exec(buildCreateTableSql(name, def, dialect));
      for (const idx of def.indexes || []) {
        try { db.exec(idx); } catch {}
      }
    }
  },
  upPostgres: rateLimitsPostgres,
};
