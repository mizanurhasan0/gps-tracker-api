import { Public } from '../auth/auth.guard';
import { Controller, Get } from '@nestjs/common';
import { appConfig } from '../config/app.config';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): Record<string, unknown> {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      device: {
        host: appConfig.tcp.publicHost,
        port: appConfig.tcp.port,
      },
    };
  }
}
