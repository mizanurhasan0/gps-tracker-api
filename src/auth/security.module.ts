import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseService } from '../database/database.service';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    DatabaseService,
    AuthService,
    AccessService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [DatabaseService, AuthService, AccessService],
})
export class SecurityModule {}
