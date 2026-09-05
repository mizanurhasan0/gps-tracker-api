import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuthRequest } from '../auth/auth.types';
import {
  DecisionDto,
  GenerateBillsDto,
  MonthlyQueryDto,
  PaymentAccountDto,
  PaymentSubmissionDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get('payments/accounts') accounts() {
    return this.payments.accounts();
  }
  @Roles('ADMIN')
  @Put('admin/payment-accounts/:method')
  @HttpCode(204)
  account(
    @Req() req: AuthRequest,
    @Param('method') method: string,
    @Body() input: PaymentAccountDto,
  ) {
    this.payments.setAccount(req.user, method, input);
  }
  @Get('payments/monthly')
  monthly(@Req() req: AuthRequest, @Query() query: MonthlyQueryDto) {
    return this.payments.listBills(req.user, query.month);
  }
  @Get('payments/submissions') history(@Req() req: AuthRequest) {
    return this.payments.listSubmissions(req.user);
  }
  @Roles('GUARDIAN')
  @Post('payments/submissions')
  submit(@Req() req: AuthRequest, @Body() input: PaymentSubmissionDto) {
    return this.payments.submit(req.user, input);
  }
  @Roles('ADMIN')
  @Post('admin/bills/generate')
  generate(@Req() req: AuthRequest, @Body() input: GenerateBillsDto) {
    return this.payments.generateBills(req.user, input.month);
  }
  @Roles('ADMIN')
  @Patch('admin/payments/:id/decision')
  review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: DecisionDto,
  ) {
    return this.payments.review(req.user, id, input);
  }
}
