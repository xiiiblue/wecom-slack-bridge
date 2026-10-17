import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A separate SQLite connection holds an OS-backed exclusive lock for this process.
    // Unlike a PID file it releases automatically after crashes, without unsafe stale-lock deletion.
    this.lease = new DatabaseSync(join(dir, 'instance.sqlite'));
    chmodSync(join(dir, 'instance.sqlite'), 0o600);
    this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    this.db = new DatabaseSync(join(dir, 'bridge.sqlite'));
    chmodSync(join(dir, 'bridge.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, source TEXT UNIQUE, target TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, root TEXT UNIQUE, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, request TEXT NOT NULL, direction TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');`);
    this.db.exec("UPDATE jobs SET status='unknown' WHERE status='sending'");
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  addJob(id, direction, payload) { this.run('INSERT INTO jobs(request,direction,payload) VALUES (?,?,?)', id, direction, JSON.stringify(payload)); }
  prune(now) {
    this.transaction(() => {
      this.run('DELETE FROM jobs WHERE request IN (SELECT id FROM requests WHERE expires < ?)', now);
      this.run('DELETE FROM requests WHERE expires < ?', now);
      this.run('DELETE FROM seen WHERE created < ?', now - 7 * 86400000);
    });
  }
  counts() { return this.all('SELECT status, count(*) AS count FROM jobs GROUP BY status'); }
  close() { this.db.close(); this.lease.close(); }
}
