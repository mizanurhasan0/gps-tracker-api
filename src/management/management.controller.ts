import { dhakaMonth } from '../common/dhaka-time';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuthRequest } from '../auth/auth.types';
import { DecisionDto } from '../payments/payments.dto';
import {
  AttendanceBatchDto,
  CreateBannerDto,
  CreateDriverDto,
  CreateLedgerDto,
  CreateMaintenanceDto,
  CreateManagementRequestDto,
  CreateNoticeDto,
  CreateStudentDto,
  ScheduleDto,
  SettingsDto,
  StopStudentServiceDto,
  UpdateBannerDto,
  UpdateDriverDto,
  UpdateMaintenanceDto,
  UpdateStudentDto,
} from './management.dto';
import { ManagementService } from './management.service';

@Controller()
export class ManagementController {
  constructor(private readonly service: ManagementService) {}
  @Get('management/overview') overview(@Req() req: AuthRequest) {
    return this.service.overview(req.user);
  }
  @Roles('ADMIN') @Post('admin/students') student(
    @Req() req: AuthRequest,
    @Body() input: CreateStudentDto,
  ) {
    return this.service.saveStudent(req.user, input);
  }
  @Roles('ADMIN') @Patch('admin/students/:id') updateStudent(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateStudentDto,
  ) {
    return this.service.saveStudent(req.user, input, id);
  }
  @Roles('ADMIN') @Get('admin/students/archived') archivedStudents(@Req() req: AuthRequest) {
    return this.service.archivedStudents(req.user);
  }
  @Roles('ADMIN') @Patch('admin/students/:id/archive') archiveStudent(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.archiveStudent(req.user, id);
  }
  @Roles('ADMIN') @Patch('admin/students/:id/restore') restoreStudent(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.restoreStudent(req.user, id);
  }
  @Roles('ADMIN') @Patch('admin/students/:id/stop') stopStudentService(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: StopStudentServiceDto,
  ) {
    return this.service.stopStudentService(req.user, id, input);
  }
  @Roles('ADMIN') @Post('admin/drivers') driver(
    @Req() req: AuthRequest,
    @Body() input: CreateDriverDto,
  ) {
    return this.service.saveDriver(req.user, input);
  }
  @Roles('ADMIN') @Patch('admin/drivers/:id') updateDriver(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateDriverDto,
  ) {
    return this.service.saveDriver(req.user, input, id);
  }
  @Roles('ADMIN') @Put('admin/attendance') attendance(
    @Req() req: AuthRequest,
    @Body() input: AttendanceBatchDto,
  ) {
    return this.service.attendance(req.user, input);
  }
  @Roles('ADMIN') @Post('admin/maintenance') maintenance(
    @Req() req: AuthRequest,
    @Body() input: CreateMaintenanceDto,
  ) {
    return this.service.saveMaintenance(req.user, input);
  }
  @Roles('ADMIN') @Patch('admin/maintenance/:id') updateMaintenance(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateMaintenanceDto,
  ) {
    return this.service.saveMaintenance(req.user, input, id);
  }
  @Roles('ADMIN') @Post('admin/ledger') ledger(
    @Req() req: AuthRequest,
    @Body() input: CreateLedgerDto,
  ) {
    return this.service.ledger(req.user, input);
  }
  @Roles('ADMIN') @Post('admin/notices') notice(
    @Req() req: AuthRequest,
    @Body() input: CreateNoticeDto,
  ) {
    return this.service.notice(req.user, input);
  }
  @Roles('ADMIN') @Post('admin/banners') banner(
    @Req() req: AuthRequest,
    @Body() input: CreateBannerDto,
  ) {
    return this.service.saveBanner(req.user, input);
  }
  @Roles('ADMIN') @Patch('admin/banners/:id') updateBanner(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateBannerDto,
  ) {
    return this.service.saveBanner(req.user, input, id);
  }
  @Roles('ADMIN') @Delete('admin/banners/:id') deleteBanner(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteBanner(req.user, id);
  }
  @Post('management/requests') request(
    @Req() req: AuthRequest,
    @Body() input: CreateManagementRequestDto,
  ) {
    return this.service.request(req.user, input);
  }
  @Roles('ADMIN') @Patch('admin/management-requests/:id/decision') decision(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: DecisionDto,
  ) {
    return this.service.decision(req.user, id, input);
  }
  @Roles('ADMIN') @Patch('admin/settings') settings(
    @Req() req: AuthRequest,
    @Body() input: SettingsDto,
  ) {
    return this.service.updateSettings(req.user, input);
  }
  @Roles('ADMIN') @Put('admin/routes/:id/schedule') schedule(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ScheduleDto,
  ) {
    return this.service.schedule(req.user, id, input);
  }
  @Roles('ADMIN') @Get('admin/reports') reports(@Query('month') month?: string) {
    return this.service.report(month ?? dhakaMonth());
  }
}
