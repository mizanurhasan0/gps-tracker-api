export interface TelegramChat {
  id?: unknown;
  type?: unknown;
  username?: unknown;
  first_name?: unknown;
}

export interface TelegramMessage {
  chat?: TelegramChat;
  text?: unknown;
}

export interface TelegramUpdateDto {
  update_id?: unknown;
  message?: TelegramMessage;
}

export interface TelegramConnectResponse {
  enabled: true;
  url: string;
  expiresAt: string;
}

export interface TelegramStatusResponse {
  enabled: boolean;
  connected: boolean;
  connectedAt: string | null;
  username: string | null;
  chatIdLast4: string | null;
}

export interface TelegramUpdateResult {
  handled: boolean;
}

export interface TelegramApiEnvelope<T> {
  ok?: unknown;
  result?: T;
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}
