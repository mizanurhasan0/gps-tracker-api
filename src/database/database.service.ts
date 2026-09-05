import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appConfig } from '../config/app.config';
import { schema } from './schema';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly connection: DatabaseSync;

  constructor() {
    mkdirSync(appConfig.storage.dataDir, { recursive: true });
    this.connection = new DatabaseSync(
      join(appConfig.storage.dataDir, 'transport.sqlite'),
    );
    this.connection.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    this.connection.exec(schema);
    this.migrateVehicles();
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params);
  }

  /** Keep callbacks synchronous: a transaction must never cross an await. */
  transaction<T>(work: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  onApplicationShutdown(): void {
    this.connection.close();
  }

  private migrateVehicles(): void {
    if (this.get('SELECT version FROM migrations WHERE version = 2')) return;
    const file = join(appConfig.storage.dataDir, 'vehicles.json');
    this.transaction(() => {
      if (existsSync(file)) {
        const vehicles = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(vehicles))
          throw new Error('vehicles.json must contain an array');
        for (const vehicle of vehicles) {
          this.run(
            `INSERT INTO vehicles (id,name,plate,imei,driverName,driverPhone,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?,?)`,
            vehicle.id,
            vehicle.name,
            vehicle.plate,
            vehicle.imei,
            vehicle.driverName ?? null,
            vehicle.driverPhone ?? null,
            vehicle.createdAt,
            vehicle.updatedAt,
          );
        }
      }
      this.run('INSERT INTO migrations(version) VALUES (2)');
    });
  }
}
