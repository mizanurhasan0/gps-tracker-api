import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { AuthRequest } from '../auth/auth.types';
import { Roles } from '../auth/auth.guard';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Roles('GUARDIAN')
  @Post('connect')
  connect(@Req() request: AuthRequest) {
    return this.telegram.issueConnectLink(request.user.id);
  }

  @Roles('GUARDIAN')
  @Get('status')
  status(@Req() request: AuthRequest) {
    return this.telegram.status(request.user.id);
  }

  @Roles('GUARDIAN')
  @Delete()
  @HttpCode(204)
  disconnect(@Req() request: AuthRequest) {
    return this.telegram.disconnect(request.user.id);
  }
}
