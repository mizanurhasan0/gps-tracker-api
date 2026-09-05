import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  entityId: string;
  createdAt: string;
  readAt: string | null;
}
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}
  async create(
    userId: string,
    title: string,
    body: string,
    entityId: string
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO notifications (id,"userId",title,body,"entityId","createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
      randomUUID(),
      userId,
      title,
      body,
      entityId,
      new Date().toISOString()
    );
  }
  async admins(title: string, body: string, entityId: string): Promise<void> {
    for (const admin of await this.db.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'ADMIN'"
    ))
      await this.create(admin.id, title, body, entityId);
  }
  list(userId: string): Promise<Notification[]> {
    return this.db.all<Notification>(
      'SELECT * FROM notifications WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 100',
      userId
    );
  }
  async read(userId: string, id: string): Promise<void> {
    if (
      !(
        await this.db.run(
          'UPDATE notifications SET "readAt" = COALESCE("readAt", $1) WHERE id = $2 AND "userId" = $3',
          new Date().toISOString(),
          id,
          userId
        )
      ).changes
    ) {
      throw new NotFoundException('Notification not found');
    }
  }
  async audit(
    actorId: string,
    action: string,
    entityId: string,
    note = ''
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_logs (id,"actorId",action,"entityId",note,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
      randomUUID(),
      actorId,
      action,
      entityId,
      note,
      new Date().toISOString()
    );
  }
}
