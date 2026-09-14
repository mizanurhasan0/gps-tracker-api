import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuthRequest } from '../auth/auth.types';
import { DecisionDto } from '../payments/payments.dto';
import {
  ComplaintDto,
  ComplaintReviewDto,
  CreateRouteDto,
  CreateServiceRequestDto,
  NoteDto,
  RouteFaresDto,
  StopRequestDto,
} from './transport.dto';
import { TransportService } from './transport.service';
@Controller()
export class TransportController {
  constructor(private readonly transport: TransportService) {}
  @Get('routes') routes() {
    return this.transport.routes();
  }
  @Roles('ADMIN')
  @Post('admin/routes')
  createRoute(@Req() req: AuthRequest, @Body() input: CreateRouteDto) {
    return this.transport.createRoute(req.user, input);
  }
  @Roles('ADMIN')
  @Put('admin/routes/:id/fares')
  fares(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: RouteFaresDto) {
    return this.transport.saveFares(req.user, id, input);
  }
  @Get('requests/mine') requests(@Req() req: AuthRequest) {
    return this.transport.requests(req.user);
  }
  @Roles('ADMIN') @Get('admin/requests') adminRequests(
    @Req() req: AuthRequest,
  ) {
    return this.transport.requests(req.user);
  }
  @Get('subscriptions') subscriptions(@Req() req: AuthRequest) {
    return this.transport.subscriptions(req.user);
  }
  @Roles('GUARDIAN')
  @Post('requests/guardian/new')
  request(@Req() req: AuthRequest, @Body() input: CreateServiceRequestDto) {
    return this.transport.request(req.user, input);
  }
  @Roles('ADMIN')
  @Patch('admin/requests/:id/decision')
  review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: DecisionDto,
  ) {
    return this.transport.reviewRequest(req.user, id, input);
  }
  @Roles('ADMIN')
  @Post('admin/requests/:id/call-notes')
  call(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: NoteDto,
  ) {
    return this.transport.callNote(req.user, id, input.note);
  }
  @Get('complaint-categories') categories() {
    return [
      'LATE_PICKUP',
      'DRIVER_BEHAVIOUR',
      'VEHICLE_SAFETY',
      'PAYMENT',
      'OTHER',
    ];
  }
  @Get('complaints') complaints(@Req() req: AuthRequest) {
    return this.transport.complaints(req.user);
  }
  @Roles('GUARDIAN')
  @Post('complaints')
  complain(@Req() req: AuthRequest, @Body() input: ComplaintDto) {
    return this.transport.complain(req.user, input);
  }
  @Roles('ADMIN')
  @Patch('admin/complaints/:id')
  reviewComplaint(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: ComplaintReviewDto,
  ) {
    return this.transport.reviewComplaint(req.user, id, input);
  }
  @Get('stop-requests') stops(@Req() req: AuthRequest) {
    return this.transport.stops(req.user);
  }
  @Roles('GUARDIAN')
  @Post('stop-requests')
  stop(@Req() req: AuthRequest, @Body() input: StopRequestDto) {
    return this.transport.stop(req.user, input);
  }
  @Roles('ADMIN')
  @Patch('admin/stop-requests/:id/decision')
  reviewStop(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: DecisionDto,
  ) {
    return this.transport.reviewStop(req.user, id, input);
  }
}
