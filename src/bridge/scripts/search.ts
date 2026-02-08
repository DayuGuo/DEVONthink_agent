/**
 * search.ts — Search-related JXA templates
 */

import { escapeForJXA } from "../executor.js";

/**
 * Generate a JXA script to search DEVONthink databases.
 * Returns JSON array [{uuid, name, score, recordType, tags, location, database, modificationDate}]
 */
export function searchScript(
  query: string,
  database?: string,
  limit: number = 20,
): string {
  const q = escapeForJXA(query);
  // JXA's app.databases() returns an ObjectSpecifier which doesn't support ES6 array methods like .find()
  // Must use a for loop for manual lookup
  const dbName = database ? escapeForJXA(database) : "null";

  return `(() => {
  const app = Application("DEVONthink");
  let dbRoot = null;
  const dbName = ${dbName};
  if (dbName) {
    const allDbs = app.databases();
    for (let i = 0; i < allDbs.length; i++) {
      if (allDbs[i].name() === dbName) { dbRoot = allDbs[i].root(); break; }
    }
    if (!dbRoot) return JSON.stringify({error: "Database not found: " + dbName});
  }
  // DT 4.2's search command 'in' parameter requires a record (group) object, not a database object.
  // Use db.root() to get the database's root group as the search scope.
  const results = dbRoot ? app.search(${q}, {in: dbRoot}) : app.search(${q});
  const limit = Math.min(results.length, ${limit});
  const out = [];
  for (let i = 0; i < limit; i++) {
    const r = results[i];
    out.push({
      uuid: r.uuid(),
      name: r.name(),
      score: r.score(),
      recordType: r.recordType(),
      tags: r.tags(),
      location: r.location(),
      database: r.database().name(),
      modificationDate: r.modificationDate().toISOString(),
    });
  }
  return JSON.stringify(out);
})()`;
}

/**
 * Use DEVONthink's "See Also" AI to find records related to a specified document.
 *
 * Note: In DT 4.2 JXA, the compare command returns an array of record objects (not wrappers),
 * each with a score property. The method name is app.compare(), not app.compareRecord().
 */
export function getRelatedScript(uuid: string, limit: number = 10): string {
  const u = escapeForJXA(uuid);
  return `(() => {
  const app = Application("DEVONthink");
  const rec = app.getRecordWithUuid(${u});
  if (!rec) return JSON.stringify({error: "Record not found"});
  const related = app.compare(rec, {to: rec.database()});
  const max = Math.min(related.length, ${limit});
  const out = [];
  for (let i = 0; i < related.length && out.length < max; i++) {
    const r = related[i];
    if (r.uuid() === ${u}) continue;
    out.push({
      uuid: r.uuid(),
      name: r.name(),
      score: r.score(),
      recordType: r.recordType(),
      tags: r.tags(),
      database: r.database().name(),
    });
  }
  return JSON.stringify(out);
})()`;
}

/**
 * Use DEVONthink AI to recommend the best filing location.
 *
 * Note: In DT 4.2 JXA, the classify command returns an array of record objects (recommended target groups),
 * each with a score property. The method name is app.classify(), not app.classifyRecord().
 */
export function classifyScript(uuid: string): string {
  const u = escapeForJXA(uuid);
  return `(() => {
  const app = Application("DEVONthink");
  const rec = app.getRecordWithUuid(${u});
  if (!rec) return JSON.stringify({error: "Record not found"});
  const proposals = app.classify(rec);
  const max = Math.min(proposals.length, 5);
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = proposals[i];
    out.push({
      uuid: p.uuid(),
      name: p.name(),
      score: p.score(),
      location: p.location(),
      database: p.database().name(),
    });
  }
  return JSON.stringify(out);
})()`;
}
