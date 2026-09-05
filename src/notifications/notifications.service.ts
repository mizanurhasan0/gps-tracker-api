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
  create(userId: string, title: string, body: string, entityId: string): void {
    this.db.run(
      'INSERT INTO notifications (id,userId,title,body,entityId,createdAt) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      userId,
      title,
      body,
      entityId,
      new Date().toISOString(),
    );
  }
  admins(title: string, body: string, entityId: string): void {
    for (const admin of this.db.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'ADMIN'",
    ))
      this.create(admin.id, title, body, entityId);
  }
  list(userId: string): Notification[] {
    return this.db.all(
      'SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 100',
      userId,
    );
  }
  read(userId: string, id: string): void {
    if (
      !this.db.run(
        'UPDATE notifications SET readAt = COALESCE(readAt, ?) WHERE id = ? AND userId = ?',
        new Date().toISOString(),
        id,
        userId,
      ).changes
    ) {
      throw new NotFoundException('Notification not found');
    }
  }
  audit(actorId: string, action: string, entityId: string, note = ''): void {
    this.db.run(
      'INSERT INTO audit_logs VALUES (?,?,?,?,?,?)',
      randomUUID(),
      actorId,
      action,
      entityId,
      note,
      new Date().toISOString(),
    );
  }
}
