import { Public } from '../auth/auth.guard';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { appConfig } from '../config/app.config';
import { DatabaseService } from '../database/database.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async check(): Promise<Record<string, unknown>> {
    try {
      await this.database.get('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    return {
      status: 'ok',
      database: 'postgresql',
      uptimeSeconds: Math.round(process.uptime()),
      device: {
        host: appConfig.tcp.publicHost,
        port: appConfig.tcp.port,
      },
    };
  }
}
