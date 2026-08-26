import { createClient } from '@libsql/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import xdg from '@folder/xdg';
import type { Store, StoreQuery, KnowledgeHit } from './types.js';

/** Only letters (any script), digits, and internal hyphens survive. Terms
 * originate in repository frontmatter, which is attacker-controlled the
 * moment an agent runs `lat` in a repo nobody here owns — a term containing
 * a double quote would break out of the quoted FTS5 MATCH string, so
 * anything that doesn't match this shape is dropped before it ever reaches
 * SQL. Unicode letters/digits are allowed (not just ASCII) so a tag written
 * in a non-Latin script still reaches the store instead of being silently
 * dropped — sqlite's FTS5 tokenizer handles them fine, and they carry no
 * special meaning to the MATCH syntax the way quotes or parens would. */
const SAFE_TERM = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

function dbPath(): string {
  return process.env.CQ_LOCAL_DB_PATH ?? join(xdg().data, 'cq', 'local.db');
}

export const cqStore: Store = {
  name: 'cq',

  async query(q: StoreQuery): Promise<KnowledgeHit[]> {
    try {
      const path = dbPath();
      if (!existsSync(path)) return [];

      const terms = q.terms.filter((t) => SAFE_TERM.test(t));
      if (terms.length === 0) return [];

      const match = terms.map((t) => `"${t}"`).join(' OR ');

      const client = createClient({ url: `file:${path}` });
      try {
        // A client returning structured rows (rather than shelling out to the
        // `sqlite3` CLI, whose one-row-per-line list output needs newlines
        // flattened and a control character as column separator to survive a
        // summary containing '\n' or '|') removes a whole class of parsing
        // bugs by construction.
        const result = await client.execute({
          sql: `SELECT rowid, summary, substr(action, 1, 400) AS action
                FROM knowledge_units_fts
                WHERE knowledge_units_fts MATCH ?
                ORDER BY rank
                LIMIT ?`,
          args: [match, q.limit],
        });

        const hits: KnowledgeHit[] = [];
        for (const row of result.rows) {
          const summary = row.summary;
          if (typeof summary !== 'string' || summary.length === 0) continue;
          const action = row.action;
          hits.push({
            store: 'cq',
            key: `cq:${row.rowid}`,
            title: summary,
            detail: typeof action === 'string' ? action : '',
            // cq ranks internally via bm25 and cannot attribute a match to
            // individual terms, so it reports the full term count and relies
            // on the caller's stable sort to preserve this query's order.
            score: terms.length,
          });
        }
        return hits;
      } finally {
        client.close();
      }
    } catch {
      // Missing table, malformed FTS syntax, corrupt database, unexpected
      // schema — every failure mode here is an absent-optional-store result,
      // never a thrown error that could fail the user's prompt.
      return [];
    }
  },
};
