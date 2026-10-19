import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuthRequest } from '../auth/auth.types';
import {
  MessageTemplateDto,
  TelegramMessageDto,
  TelegramMessageListQueryDto,
  TelegramRecipientsQueryDto,
  UpdateMessageTemplateDto,
} from './messaging.dto';
import { MessagingService } from './messaging.service';

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

/** Contract: docs/TELEGRAM_MESSAGING_API.md. */
@Roles('ADMIN')
@Controller('admin')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}
  @Get('message-templates') templates() {
    return this.messaging.templates();
  }
  @Post('message-templates') createTemplate(
    @Req() req: AuthRequest,
    @Body() input: MessageTemplateDto,
  ) {
    return this.messaging.createTemplate(req.user, input);
  }
  @Patch('message-templates/:id') updateTemplate(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateMessageTemplateDto,
  ) {
    return this.messaging.updateTemplate(req.user, id, input);
  }
  @Delete('message-templates/:id') @HttpCode(204) deleteTemplate(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messaging.deleteTemplate(req.user, id);
  }
  @Get('telegram-messages/recipients') recipients(@Query() query: TelegramRecipientsQueryDto) {
    return this.messaging.recipients(query.vehicleIds);
  }
  /** 201 for a new send; 200 when requestId replays an earlier send. */
  @Post('telegram-messages') async send(
    @Req() req: AuthRequest,
    @Body() input: TelegramMessageDto,
    @Res() response: HttpResponse,
  ): Promise<void> {
    const result = await this.messaging.send(req.user, input);
    response.status(result.created ? 201 : 200).json(result.message);
  }
  @Get('telegram-messages') list(@Query() query: TelegramMessageListQueryDto) {
    return this.messaging.list(query);
  }
  @Get('telegram-messages/:id') detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.detail(id);
  }
}
