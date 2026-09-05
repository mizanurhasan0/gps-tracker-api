import { Controller, Get, HttpCode, Param, Patch, Req } from '@nestjs/common';
import { AuthRequest } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get() list(@Req() req: AuthRequest) {
    return this.notifications.list(req.user.id);
  }
  @Patch(':id/read')
  @HttpCode(204)
  read(@Req() req: AuthRequest, @Param('id') id: string) {
    this.notifications.read(req.user.id, id);
  }
}
