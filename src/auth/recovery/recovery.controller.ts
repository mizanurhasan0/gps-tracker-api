import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { AuthRequest } from '../auth.types';
import { Public } from '../auth.guard';
import { RecoveryConfirmDto, RecoveryRequestDto } from './recovery.dto';
import { RecoveryService } from './recovery.service';

@Controller('auth/recovery')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Public()
  @Post('request')
  @HttpCode(202)
  request(@Body() input: RecoveryRequestDto, @Req() req: AuthRequest) {
    return this.recovery.request(input.email, req.ip ?? 'unknown');
  }

  @Public()
  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() input: RecoveryConfirmDto, @Req() req: AuthRequest) {
    return this.recovery.confirm(input, req.ip ?? 'unknown');
  }
}
