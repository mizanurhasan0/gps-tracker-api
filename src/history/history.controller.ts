import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { HistoryService } from './history.service';

@Controller('locations/:imei/history')
@Roles('ADMIN')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}
  @Get()
  points(@Param('imei') imei: string, @Query() query: Record<string, unknown>) {
    return this.history.history(imei, query);
  }
  @Get('summary')
  summary(
    @Param('imei') imei: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.history.summary(imei, query);
  }
  @Get('route')
  route(@Param('imei') imei: string, @Query() query: Record<string, unknown>) {
    return this.history.route(imei, query);
  }
}
