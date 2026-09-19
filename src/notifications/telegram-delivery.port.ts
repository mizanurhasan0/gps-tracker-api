/**
 * Transport boundary used by the notification worker.
 *
 * The Telegram module owns chat lookup and the actual Bot API call. Keeping
 * this boundary here lets notification creation remain independent of that
 * module and also makes delivery failures retryable without changing the
 * existing notification API.
 */
export const TELEGRAM_DELIVERY = Symbol('TELEGRAM_DELIVERY');

export interface TelegramDeliveryMessage {
  /** Stable idempotency key for the provider. */
  notificationId: string;
  userId: string;
  chatId: string;
  title: string;
  body: string;
}

export type TelegramDeliveryResult =
  | { status: 'SENT'; providerMessageId?: string }
  | { status: 'SKIPPED'; reason: string }
  | { status: 'RETRY'; reason: string };

export interface TelegramDeliveryPort {
  deliver(
    message: TelegramDeliveryMessage,
  ): Promise<TelegramDeliveryResult>;
}
