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
    // Additive migration: legacy targets lack trustworthy group/owner provenance.
    this.transaction(() => {
      if (!this.all('PRAGMA table_info(requests)').some(x => x.name === 'kind')) {
        this.db.exec(`ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE requests ADD COLUMN owner TEXT; ALTER TABLE requests ADD COLUMN channel TEXT;
          ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE jobs ADD COLUMN target TEXT;`);
        this.run("UPDATE requests SET status='quarantined'");
        this.run("UPDATE jobs SET status='quarantined' WHERE status!='sent'");
      }
      if (!this.all('PRAGMA table_info(requests)').some(x => x.name === 'ingress_bot')) this.db.exec('ALTER TABLE requests ADD COLUMN ingress_bot TEXT');
      if (!this.all('PRAGMA table_info(jobs)').some(x => x.name === 'expires')) this.db.exec('ALTER TABLE jobs ADD COLUMN expires INTEGER');
      this.db.exec(`CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, request TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL)`);
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_conversations (
      code INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL UNIQUE,
      bot TEXT NOT NULL, last_delivery INTEGER NOT NULL DEFAULT 0)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback_bindings (
      request TEXT PRIMARY KEY, repository TEXT NOT NULL, issue INTEGER NOT NULL,
      source TEXT NOT NULL, root TEXT NOT NULL, bot TEXT NOT NULL, responder_user TEXT NOT NULL, wecom_bot TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, UNIQUE(repository,issue));
      CREATE TABLE IF NOT EXISTS feedback_deliveries (
      delivery_id TEXT PRIMARY KEY, request TEXT NOT NULL, digest TEXT NOT NULL, job INTEGER NOT NULL UNIQUE);`);
    this.db.exec("UPDATE jobs SET status='unknown' WHERE status='sending'");
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  addJob(id, direction, payload, lane = direction, target = null, expires = null) { this.run('INSERT INTO jobs(request,direction,payload,lane,target,expires) VALUES (?,?,?,?,?,?)', id, direction, JSON.stringify(payload), lane, target, expires); }
  prune(now) {
    this.transaction(() => {
      this.run("DELETE FROM owner_conversations WHERE request IN (SELECT id FROM requests WHERE kind='notify' AND expires < ?)", now);
      this.run('DELETE FROM reviews WHERE expires < ?', now);
      this.run("DELETE FROM jobs WHERE expires < ? OR request IN (SELECT id FROM requests WHERE kind IN ('single','group','legacy','notify') AND expires < ?)", now, now);
      this.run("DELETE FROM requests WHERE kind IN ('single','group','legacy','notify') AND expires < ?", now);
      this.run('DELETE FROM seen WHERE created < ?', now - 7 * 86400000);
    });
  }
  counts() { return this.all('SELECT status, count(*) AS count FROM jobs GROUP BY status'); }
  close() { this.db.close(); this.lease.close(); }
}
