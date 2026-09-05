import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Small synchronous JSON file store. Suitable for the low write volume of a
 * handful of trackers; swap for a database when device count grows.
 */
export class JsonStore<T> {
  private readonly logger: Logger;
  private readonly filePath: string;

  constructor(directory: string, fileName: string) {
    this.filePath = path.join(directory, fileName);
    this.logger = new Logger(`JsonStore(${fileName})`);
  }

  read(fallback: T): T {
    try {
      if (!fs.existsSync(this.filePath)) {
        return fallback;
      }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as T;
    } catch (error) {
      this.logger.error(`Read failed: ${(error as Error).message}`);
      return fallback;
    }
  }

  write(value: T): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2), 'utf8');
    } catch (error) {
      this.logger.error(`Write failed: ${(error as Error).message}`);
    }
  }
}
