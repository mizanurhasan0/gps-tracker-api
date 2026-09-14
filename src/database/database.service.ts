import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { schema } from './schema';
import { managementSchema } from './management.schema';
import { faresSchema } from './fares.schema';
import { shiftsSchema } from './shifts.schema';
import { appConfig } from '../config/app.config';

export interface MutationResult {
  rowCount: number;
  /** Compatibility with existing affected-row checks. */
  changes: number;
}

/** One pool and one transaction context for every application domain. */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly transactions = new AsyncLocalStorage<PoolClient>();
  private initialization?: Promise<void>;
  private closing = false;

  constructor() {
    const url = appConfig.database.url;
    if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
      throw new Error(
        'DATABASE_URL is required and must be a PostgreSQL connection URL'
      );
    }
    this.pool = new Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      query_timeout: 20000,
      idle_in_transaction_session_timeout: 20000,
    });
    this.pool.on('error', () =>
      this.logger.error('PostgreSQL connection unavailable')
    );
  }

  async onModuleInit(): Promise<void> {
    await this.ensureReady();
  }

  ensureReady(): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error('Database is shutting down'));
    if (!this.initialization) {
      this.initialization = this.migrate().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(74523001)');
      await client.query(`CREATE TABLE IF NOT EXISTS app_migrations (
        version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const applied = await client.query(
        'SELECT version FROM app_migrations WHERE version = 1'
      );
      if (!applied.rowCount) {
        await client.query(schema);
        await client.query('INSERT INTO app_migrations(version) VALUES(1)');
      }
      const managementApplied = await client.query('SELECT version FROM app_migrations WHERE version = 2');
      if (!managementApplied.rowCount) {
        await client.query(managementSchema);
        await client.query('INSERT INTO app_migrations(version) VALUES(2)');
      }
      const faresApplied = await client.query('SELECT version FROM app_migrations WHERE version = 3');
      if (!faresApplied.rowCount) {
        await client.query(faresSchema);
        await client.query('INSERT INTO app_migrations(version) VALUES(3)');
      }
      const shiftsApplied = await client.query('SELECT version FROM app_migrations WHERE version = 4');
      if (!shiftsApplied.rowCount) {
        await client.query(shiftsSchema);
        const legacyData = await client.query('SELECT 1 FROM users LIMIT 1');
        if (!applied.rowCount && !legacyData.rowCount) await client.query("UPDATE business_settings SET data=jsonb_set(data,'{operatingDays}','[0,1,2,3,4,6]') WHERE id=1");
        await client.query('INSERT INTO app_migrations(version) VALUES(4)');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    await this.ensureReady();
    const executor = this.transactions.getStore() ?? this.pool;
    const result = await executor.query<QueryResultRow>(sql, params);
    return result.rows as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return (await this.all<T>(sql, ...params))[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<MutationResult> {
    await this.ensureReady();
    const executor = this.transactions.getStore() ?? this.pool;
    const result = await executor.query(sql, params);
    return { rowCount: result.rowCount ?? 0, changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.run(sql);
  }

  /** Nested services join the same transaction; only the outer callback retries.
   * Keep external side effects outside callbacks: a serializable conflict retries them.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()) return work();
    await this.ensureReady();
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await this.transactions.run(client, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (error as { code?: string }).code;
        if (attempt >= 3 || (code !== '40001' && code !== '40P01')) throw error;
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    await this.pool.end();
  }
}
