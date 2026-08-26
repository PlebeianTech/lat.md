import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { rmDirBestEffort } from '../util.js';
import { cqStore } from '../../src/knowledge/cq.js';

async function makeDb(
  path: string,
  rows: Array<{ summary: string; action: string }>,
): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.execute(
    'CREATE VIRTUAL TABLE knowledge_units_fts USING fts5(summary, action)',
  );
  for (const row of rows) {
    await client.execute({
      sql: 'INSERT INTO knowledge_units_fts (summary, action) VALUES (?, ?)',
      args: [row.summary, row.action],
    });
  }
  client.close();
}

describe('cqStore', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lat-cq-'));
    prevEnv = process.env.CQ_LOCAL_DB_PATH;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CQ_LOCAL_DB_PATH;
    else process.env.CQ_LOCAL_DB_PATH = prevEnv;
    rmDirBestEffort(tmp);
  });

  it('has the expected name', () => {
    expect(cqStore.name).toBe('cq');
  });

  it('returns a matching row with correct shape', async () => {
    const dbFile = join(tmp, 'local.db');
    await makeDb(dbFile, [
      { summary: 'docker build fails on arm64', action: 'use buildx' },
    ]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['docker'],
      projectRoot: tmp,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      store: 'cq',
      key: `cq:1`,
      title: 'docker build fails on arm64',
      detail: 'use buildx',
      score: 1,
    });
  });

  it('finds two rows matching two different terms', async () => {
    const dbFile = join(tmp, 'local.db');
    await makeDb(dbFile, [
      { summary: 'docker build fails', action: 'a' },
      { summary: 'vitest config oddity', action: 'b' },
      { summary: 'unrelated entry', action: 'c' },
    ]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['docker', 'vitest'],
      projectRoot: tmp,
      limit: 10,
    });

    const titles = hits.map((h) => h.title).sort();
    expect(titles).toEqual(['docker build fails', 'vitest config oddity']);
    expect(hits.every((h) => h.score === 2)).toBe(true);
  });

  it('respects the limit', async () => {
    const dbFile = join(tmp, 'local.db');
    await makeDb(dbFile, [
      { summary: 'docker one', action: 'a' },
      { summary: 'docker two', action: 'b' },
      { summary: 'docker three', action: 'c' },
    ]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['docker'],
      projectRoot: tmp,
      limit: 2,
    });

    expect(hits).toHaveLength(2);
  });

  it('returns [] when the database file is missing', async () => {
    process.env.CQ_LOCAL_DB_PATH = join(tmp, 'does-not-exist.db');

    const hits = await cqStore.query({
      terms: ['docker'],
      projectRoot: tmp,
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('returns [] when knowledge_units_fts does not exist', async () => {
    const dbFile = join(tmp, 'local.db');
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute('CREATE TABLE other_table (id INTEGER)');
    client.close();
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['docker'],
      projectRoot: tmp,
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('drops a term with a double quote instead of reaching MATCH', async () => {
    const dbFile = join(tmp, 'local.db');
    await makeDb(dbFile, [{ summary: 'docker build fails', action: 'a' }]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const allInvalid = await cqStore.query({
      terms: ['bad"term', '"; DROP TABLE knowledge_units_fts; --'],
      projectRoot: tmp,
      limit: 10,
    });
    expect(allInvalid).toEqual([]);

    const mixed = await cqStore.query({
      terms: ['docker', 'bad"term'],
      projectRoot: tmp,
      limit: 10,
    });
    expect(mixed).toHaveLength(1);
    expect(mixed[0].title).toBe('docker build fails');
  });

  it('returns a summary with a newline and a pipe intact in one hit', async () => {
    const dbFile = join(tmp, 'local.db');
    const summary = 'docker build\nfails on arm64 | needs buildx';
    await makeDb(dbFile, [{ summary, action: 'use buildx' }]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['docker'],
      projectRoot: tmp,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(summary);
  });

  // @lat: [[knowledge-store#cq store lookup and encoding#Finds a db under XDG_DATA_HOME when CQ_LOCAL_DB_PATH is unset]]
  it('finds a db placed under XDG_DATA_HOME when CQ_LOCAL_DB_PATH is unset', async () => {
    const prevXdg = process.env.XDG_DATA_HOME;
    delete process.env.CQ_LOCAL_DB_PATH;
    process.env.XDG_DATA_HOME = tmp;
    const dbDir = join(tmp, 'cq');
    mkdirSync(dbDir, { recursive: true });
    const dbFile = join(dbDir, 'local.db');
    await makeDb(dbFile, [{ summary: 'docker build fails', action: 'a' }]);

    try {
      const hits = await cqStore.query({
        terms: ['docker'],
        projectRoot: tmp,
        limit: 10,
      });
      expect(hits).toHaveLength(1);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });

  // @lat: [[knowledge-store#cq store lookup and encoding#Keeps a non-ASCII term instead of dropping it]]
  it('keeps a term with a non-ASCII letter instead of dropping it', async () => {
    const dbFile = join(tmp, 'local.db');
    await makeDb(dbFile, [{ summary: 'café build fails', action: 'a' }]);
    process.env.CQ_LOCAL_DB_PATH = dbFile;

    const hits = await cqStore.query({
      terms: ['café'],
      projectRoot: tmp,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('café build fails');
  });
});
