import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TelegramService } from '../telegram/telegram.service';
import {
  TelegramDeliveryMessage,
  TelegramDeliveryPort,
  TelegramDeliveryResult,
} from './telegram-delivery.port';

/** Bridges the notification worker to the Telegram module without coupling it
 * to Telegram's connection or Bot API implementation. */
@Injectable()
export class TelegramDeliveryAdapter implements TelegramDeliveryPort {
  constructor(
    private readonly db: DatabaseService,
    private readonly telegram: TelegramService,
  ) {}

  async deliver(
    message: TelegramDeliveryMessage,
  ): Promise<TelegramDeliveryResult> {
    const connection = await this.db.get<{ chatId: string }>(
      `SELECT "chatId"
       FROM telegram_connections
       WHERE "guardianId" = $1 AND "chatId" = $2 AND status = 'CONNECTED'`,
      message.userId,
      message.chatId,
    );
    if (!connection) {
      return {
        status: 'SKIPPED',
        reason: 'Telegram is no longer connected for this guardian',
      };
    }

    await this.telegram.sendMessage(
      message.chatId,
      `${message.title}\n\n${message.body}`,
    );
    return { status: 'SENT' };
  }
}
