import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import {
  DELIVERY_MAX_ATTEMPTS,
  NotificationsService,
} from '../notifications/notifications.service';
import {
  MessageTemplateDto,
  TelegramMessageDto,
  TelegramMessageListQueryDto,
  UpdateMessageTemplateDto,
} from './messaging.dto';

/** Response shapes: docs/TELEGRAM_MESSAGING_API.md (mirrored by the mobile client). */
export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface RecipientGuardian {
  guardianId: string;
  name: string;
  phone: string;
  studentNames: string[];
  telegramConnected: boolean;
}
export interface RecipientVehicle {
  vehicleId: string;
  name: string;
  plate: string;
  guardians: RecipientGuardian[];
}
export interface TelegramRecipientsResponse {
  vehicles: RecipientVehicle[];
  totals: { guardians: number; telegramConnected: number };
}
export type TelegramMessageAudience = 'ALL' | 'SELECTED';
export type TelegramRecipientStatus = 'SENT' | 'PENDING' | 'FAILED' | 'APP_ONLY';
export interface TelegramMessageStats {
  recipients: number;
  sent: number;
  pending: number;
  failed: number;
  appOnly: number;
}
export interface TelegramMessageSummary {
  id: string;
  title: string;
  body: string;
  audience: TelegramMessageAudience;
  vehicles: { id: string; name: string }[];
  templateId: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  stats: TelegramMessageStats;
}
export interface TelegramMessageRecipient {
  guardianId: string;
  name: string;
  phone: string;
  status: TelegramRecipientStatus;
  sentAt: string | null;
  error: string | null;
}
export interface TelegramMessageDetail extends TelegramMessageSummary {
  recipients: TelegramMessageRecipient[];
}
export interface SendResult {
  /** False when requestId matched an earlier send by the same admin. */
  created: boolean;
  message: TelegramMessageDetail;
}
export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type Timestamp = Date | string;
interface TemplateRow {
  id: string;
  title: string;
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
interface EligibleRow {
  vehicleId: string;
  guardianId: string;
  name: string;
  phone: string;
  studentNames: string[];
  telegramConnected: boolean;
}
interface MessageRow {
  id: string;
  title: string;
  body: string;
  audience: TelegramMessageAudience;
  vehicles: { id: string; name: string }[];
  templateId: string | null;
  createdAt: Timestamp;
  createdBy: string | null;
  createdByName: string | null;
}
interface RecipientRow {
  guardianId: string;
  name: string;
  phone: string;
  status: TelegramRecipientStatus;
  sentAt: Timestamp | null;
  error: string | null;
}

const FALLBACK_TITLE = 'বার্তা';
const iso = (value: Timestamp) => new Date(value).toISOString();
const templateSelect = 'SELECT id,title,body,"createdAt","updatedAt" FROM message_templates';
const messageSelect = `SELECT m.id,m.title,m.body,m.audience,m.vehicles,m."templateId",m."createdAt",
  m."createdBy",u.name "createdByName"
  FROM telegram_messages m LEFT JOIN users u ON u.id=m."createdBy"`;
/**
 * Recipient status from the outbox row (`r` recipients, `d` deliveries). The worker
 * claims FAILED rows again until they have used DELIVERY_MAX_ATTEMPTS attempts.
 */
const recipientStatus = `CASE
  WHEN d.id IS NULL THEN CASE WHEN r."telegramQueued" THEN 'FAILED' ELSE 'APP_ONLY' END
  WHEN d.status='SENT' THEN 'SENT'
  WHEN d.status IN ('PENDING','SENDING') THEN 'PENDING'
  WHEN d.status='FAILED' AND d.attempts < ${Number(DELIVERY_MAX_ATTEMPTS)} THEN 'PENDING'
  ELSE 'FAILED' END`;
const recipientRows = `SELECT r."messageId",r."guardianId",u.name,u.phone,${recipientStatus} status,
  d."sentAt",d."lastError"
  FROM telegram_message_recipients r
  JOIN users u ON u.id=r."guardianId"
  LEFT JOIN telegram_deliveries d ON d."notificationId"=r."notificationId"`;

@Injectable()
export class MessagingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  async templates(): Promise<MessageTemplate[]> {
    const rows = await this.db.all<TemplateRow>(
      `${templateSelect} ORDER BY "updatedAt" DESC,"createdAt" DESC,id`,
    );
    return rows.map((row) => this.templateView(row));
  }

  createTemplate(actor: User, input: MessageTemplateDto): Promise<MessageTemplate> {
    return this.db.transaction(async () => {
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO message_templates(id,title,body,"createdBy","createdAt","updatedAt")
         VALUES($1,$2,$3,$4,now(),now())`,
        id,
        input.title,
        input.body,
        actor.id,
      );
      await this.notifications.audit(actor.id, 'MESSAGE_TEMPLATE_CREATED', id);
      return this.template(id);
    });
  }

  updateTemplate(
    actor: User,
    id: string,
    input: UpdateMessageTemplateDto,
  ): Promise<MessageTemplate> {
    return this.db.transaction(async () => {
      const changed = input.title !== undefined || input.body !== undefined;
      const result = await this.db.run(
        `UPDATE message_templates SET title=COALESCE($2,title),body=COALESCE($3,body),
           "updatedAt"=CASE WHEN $4::boolean THEN now() ELSE "updatedAt" END
         WHERE id=$1`,
        id,
        input.title ?? null,
        input.body ?? null,
        changed,
      );
      if (!result.rowCount) throw new NotFoundException('Saved message not found');
      if (changed) await this.notifications.audit(actor.id, 'MESSAGE_TEMPLATE_UPDATED', id);
      return this.template(id);
    });
  }

  deleteTemplate(actor: User, id: string): Promise<void> {
    return this.db.transaction(async () => {
      const result = await this.db.run('DELETE FROM message_templates WHERE id=$1', id);
      if (!result.rowCount) throw new NotFoundException('Saved message not found');
      await this.notifications.audit(actor.id, 'MESSAGE_TEMPLATE_DELETED', id);
    });
  }

  async recipients(vehicleIds: string[]): Promise<TelegramRecipientsResponse> {
    const vehicles = await this.vehicles(vehicleIds);
    const rows = await this.eligible(vehicleIds);
    const distinct = new Map(rows.map((row) => [row.guardianId, row.telegramConnected]));
    return {
      vehicles: vehicles.map((vehicle) => ({
        vehicleId: vehicle.id,
        name: vehicle.name,
        plate: vehicle.plate,
        guardians: rows
          .filter((row) => row.vehicleId === vehicle.id)
          .map((row) => ({
            guardianId: row.guardianId,
            name: row.name,
            phone: row.phone,
            studentNames: row.studentNames,
            telegramConnected: row.telegramConnected,
          })),
      })),
      totals: {
        guardians: distinct.size,
        telegramConnected: [...distinct.values()].filter(Boolean).length,
      },
    };
  }

  /**
   * Writes the history and one in-app notification per guardian in one transaction.
   * Telegram sends happen later in the outbox worker, never inside this callback.
   * A repeated requestId returns the earlier message instead of sending again.
   */
  async send(actor: User, input: TelegramMessageDto): Promise<SendResult> {
    try {
      return await this.db.transaction(async () => {
        const earlier = await this.earlierSend(actor, input.requestId);
        if (earlier) return { created: false, message: earlier };
        return { created: true, message: await this.sendNew(actor, input) };
      });
    } catch (error) {
      // A concurrent send with the same requestId won. Postgres usually reports
      // that as a serialization failure, which db.transaction() retries into the
      // replay path above; a plain unique violation on requestId lands here.
      if ((error as { code?: string }).code !== '23505') throw error;
      const earlier = await this.earlierSend(actor, input.requestId);
      if (!earlier) throw error;
      return { created: false, message: earlier };
    }
  }

  private async earlierSend(
    actor: User,
    requestId: string,
  ): Promise<TelegramMessageDetail | undefined> {
    const row = await this.db.get<{ id: string; createdBy: string | null }>(
      'SELECT id,"createdBy" FROM telegram_messages WHERE "requestId"=$1',
      requestId,
    );
    if (!row) return undefined;
    if (row.createdBy !== actor.id)
      throw new ConflictException('This message request was already used');
    return this.detail(row.id);
  }

  private async sendNew(actor: User, input: TelegramMessageDto): Promise<TelegramMessageDetail> {
    const vehicles = await this.vehicles(input.vehicleIds);
    const eligible = new Set(
      (await this.eligible(input.vehicleIds)).map((row) => row.guardianId),
    );
    if (input.guardianIds?.some((guardianId) => !eligible.has(guardianId)))
      throw new BadRequestException('Some selected guardians are not on the selected vehicles');
    const recipients = [...new Set(input.guardianIds ?? eligible)];
    if (!recipients.length)
      throw new BadRequestException('No guardians found for the selected vehicles');

    const templateId = input.templateId
      ? ((
          await this.db.get<{ id: string }>(
            'SELECT id FROM message_templates WHERE id=$1',
            input.templateId,
          )
        )?.id ?? null)
      : null;
    const title = await this.notificationTitle();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO telegram_messages(id,title,body,audience,vehicles,"templateId","createdBy","createdAt","requestId")
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,now(),$8)`,
      id,
      title,
      input.body,
      input.guardianIds ? 'SELECTED' : 'ALL',
      JSON.stringify(vehicles.map((vehicle) => ({ id: vehicle.id, name: vehicle.name }))),
      templateId,
      actor.id,
      input.requestId,
    );
    let queued = 0;
    for (const guardianId of recipients) {
      const notification = await this.notifications.create(guardianId, title, input.body, id);
      if (notification.telegramQueued) queued++;
      await this.db.run(
        `INSERT INTO telegram_message_recipients("messageId","guardianId","notificationId","telegramQueued")
         VALUES($1,$2,$3,$4)`,
        id,
        guardianId,
        notification.notificationId,
        notification.telegramQueued,
      );
    }
    await this.notifications.audit(
      actor.id,
      'TELEGRAM_MESSAGE_SENT',
      id,
      `${recipients.length} recipients, ${queued} queued for Telegram`,
    );
    return this.detail(id);
  }

  async list(query: TelegramMessageListQueryDto): Promise<Paged<TelegramMessageSummary>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const count = await this.db.get<{ total: number }>(
      'SELECT count(*)::int total FROM telegram_messages',
    );
    const total = Number(count?.total ?? 0);
    const rows = await this.db.all<MessageRow>(
      `${messageSelect} ORDER BY m."createdAt" DESC,m.id DESC LIMIT $1 OFFSET $2`,
      pageSize,
      (page - 1) * pageSize,
    );
    const stats = await this.stats(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.summary(row, stats.get(row.id))),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string): Promise<TelegramMessageDetail> {
    const row = await this.db.get<MessageRow>(`${messageSelect} WHERE m.id=$1`, id);
    if (!row) throw new NotFoundException('Telegram message not found');
    const stats = await this.stats([id]);
    const recipients = await this.db.all<RecipientRow>(
      `SELECT "guardianId",name,phone,status,
         CASE WHEN status='SENT' THEN "sentAt" END "sentAt",
         CASE WHEN status='FAILED' THEN "lastError" END error
       FROM (${recipientRows} WHERE r."messageId"=$1) recipient
       ORDER BY array_position(ARRAY['FAILED','PENDING','APP_ONLY','SENT'],status),name,"guardianId"`,
      id,
    );
    return {
      ...this.summary(row, stats.get(id)),
      recipients: recipients.map((recipient) => ({
        guardianId: recipient.guardianId,
        name: recipient.name,
        phone: recipient.phone,
        status: recipient.status,
        sentAt: recipient.sentAt === null ? null : iso(recipient.sentAt),
        error: recipient.error,
      })),
    };
  }

  private async template(id: string): Promise<MessageTemplate> {
    const row = await this.db.get<TemplateRow>(`${templateSelect} WHERE id=$1`, id);
    if (!row) throw new NotFoundException('Saved message not found');
    return this.templateView(row);
  }

  private templateView(row: TemplateRow): MessageTemplate {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  /** Returns the vehicles in request order; unknown IDs are a client error. */
  private async vehicles(ids: string[]) {
    const rows = await this.db.all<{ id: string; name: string; plate: string }>(
      'SELECT id,name,plate FROM vehicles WHERE id=ANY($1::text[])',
      ids,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (ids.some((id) => !byId.has(id)))
      throw new BadRequestException('One or more selected vehicles were not found');
    return ids.map((id) => byId.get(id)!);
  }

  /** Active enrollments on active routes of non-archived students, one row per vehicle and guardian. */
  private eligible(vehicleIds: string[]): Promise<EligibleRow[]> {
    return this.db.all<EligibleRow>(
      `SELECT r."vehicleId",u.id "guardianId",u.name,u.phone,
         array_agg(DISTINCT s."studentName" ORDER BY s."studentName") "studentNames",
         EXISTS(SELECT 1 FROM telegram_connections c
           WHERE c."guardianId"=u.id AND c.status='CONNECTED') "telegramConnected"
       FROM subscriptions s
       JOIN routes r ON r.id=s."routeId"
       JOIN student_profiles p ON p.id=s."studentId"
       JOIN users u ON u.id=s."guardianId"
       WHERE r."vehicleId"=ANY($1::text[]) AND s.status='ACTIVE' AND r.active=1
         AND p."archivedAt" IS NULL AND u.role='GUARDIAN'
       GROUP BY r."vehicleId",u.id
       ORDER BY u.name,u.id`,
      vehicleIds,
    );
  }

  private async notificationTitle(): Promise<string> {
    const settings = await this.db.get<{ businessName: string | null }>(
      `SELECT btrim(data->>'businessName') "businessName" FROM business_settings WHERE id=1`,
    );
    return settings?.businessName || FALLBACK_TITLE;
  }

  private async stats(messageIds: string[]): Promise<Map<string, TelegramMessageStats>> {
    const rows = await this.db.all<TelegramMessageStats & { messageId: string }>(
      `SELECT "messageId",count(*)::int recipients,
         count(*) FILTER (WHERE status='SENT')::int sent,
         count(*) FILTER (WHERE status='PENDING')::int pending,
         count(*) FILTER (WHERE status='FAILED')::int failed,
         count(*) FILTER (WHERE status='APP_ONLY')::int "appOnly"
       FROM (${recipientRows} WHERE r."messageId"=ANY($1::text[])) recipient
       GROUP BY "messageId"`,
      messageIds,
    );
    return new Map(
      rows.map(({ messageId, recipients, sent, pending, failed, appOnly }) => [
        messageId,
        { recipients, sent, pending, failed, appOnly },
      ]),
    );
  }

  private summary(row: MessageRow, stats?: TelegramMessageStats): TelegramMessageSummary {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      audience: row.audience,
      vehicles: row.vehicles,
      templateId: row.templateId,
      createdAt: iso(row.createdAt),
      createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName ?? '' } : null,
      stats: stats ?? { recipients: 0, sent: 0, pending: 0, failed: 0, appOnly: 0 },
    };
  }
}
