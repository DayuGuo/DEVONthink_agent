/**
 * databases.ts — Database and group browsing JXA templates
 */

import { escapeForJXA } from "../executor.js";

/**
 * List all document records across databases (metadata only, no content).
 * Used by the RAG indexer to enumerate documents for semantic indexing.
 *
 * Filters out groups, smart groups, feeds, and non-text media types.
 * If a database name is provided, only that database is scanned.
 */
export function listAllRecordsScript(database?: string): string {
  const dbFilter = database ? escapeForJXA(database) : "null";
  return `(() => {
  const app = Application("DEVONthink");
  const dbFilter = ${dbFilter};
  const allDbs = app.databases();
  const out = [];
  for (let d = 0; d < allDbs.length; d++) {
    const db = allDbs[d];
    const dbName = db.name();
    if (dbFilter && dbName !== dbFilter) continue;
    const records = app.search("*", { in: db.root() });
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const rType = r.recordType();
      if (rType === "group" || rType === "smart group" || rType === "feed"
          || rType === "picture" || rType === "movie" || rType === "sound"
          || rType === "unknown") continue;
      out.push({
        uuid: r.uuid(),
        name: r.name(),
        recordType: rType,
        database: dbName,
        modificationDate: r.modificationDate().toISOString(),
        wordCount: r.wordCount(),
      });
    }
  }
  return JSON.stringify(out);
})()`;
}

/**
 * List all open databases.
 */
export function listDatabasesScript(): string {
  return `(() => {
  const app = Application("DEVONthink");
  const dbs = app.databases();
  const out = [];
  for (let i = 0; i < dbs.length; i++) {
    const db = dbs[i];
    let count = 0;
    try { count = db.contents().length; } catch(e) { count = -1; }
    out.push({
      uuid: db.uuid(),
      name: db.name(),
      path: db.path(),
      recordCount: count,
    });
  }
  return JSON.stringify(out);
})()`;
}

/**
 * List the direct children of a group.
 * If uuid is empty, lists the current database's root contents.
 */
export function listGroupContentsScript(uuid?: string, limit: number = 30): string {
  const parent = uuid
    ? `app.getRecordWithUuid(${escapeForJXA(uuid)})`
    : "app.currentDatabase().root()";

  return `(() => {
  const app = Application("DEVONthink");
  const parent = ${parent};
  if (!parent) return JSON.stringify({error: "Group not found"});
  const kids = parent.children();
  const limit = Math.min(kids.length, ${limit});
  const out = [];
  for (let i = 0; i < limit; i++) {
    const c = kids[i];
    out.push({
      uuid: c.uuid(),
      name: c.name(),
      recordType: c.recordType(),
      size: c.size(),
      childCount: c.recordType() === "group" ? c.children().length : 0,
    });
  }
  return JSON.stringify({
    parentName: parent.name(),
    totalChildren: kids.length,
    children: out,
  });
})()`;
}
