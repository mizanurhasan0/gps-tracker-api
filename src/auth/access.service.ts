import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { User } from './auth.types';
@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}
  async canTrack(user: User, imei: string): Promise<boolean> {
    return (await this.trackingUserIds([user], imei)).has(user.id);
  }

  /** One permission query per list, preserving its original order and shape. */
  async filterTrackable<T extends { imei: string }>(user: User, records: T[]): Promise<T[]> {
    if (user.role === 'ADMIN' || records.length === 0) return records;
    const rows = await this.db.all<{ imei: string }>(
      `SELECT DISTINCT v.imei FROM subscriptions s
       JOIN routes r ON r.id=s."routeId" JOIN vehicles v ON v.id=r."vehicleId"
       WHERE s."guardianId"=$1 AND s.status='ACTIVE' AND r.active=1`,
      user.id,
    );
    const allowed = new Set(rows.map((row) => row.imei));
    return records.filter((record) => allowed.has(record.imei));
  }

  /** Recheck current assignments without caching access across broadcasts. */
  async trackingUserIds(users: Iterable<User>, imei: string): Promise<Set<string>> {
    const allowed = new Set<string>();
    const guardians = new Set<string>();
    for (const user of users) {
      if (user.role === 'ADMIN') allowed.add(user.id);
      else guardians.add(user.id);
    }
    if (guardians.size) {
      const rows = await this.db.all<{ guardianId: string }>(
        `SELECT DISTINCT s."guardianId" FROM subscriptions s
         JOIN routes r ON r.id=s."routeId" JOIN vehicles v ON v.id=r."vehicleId"
         WHERE s."guardianId"=ANY($1::text[]) AND s.status='ACTIVE'
           AND r.active=1 AND v.imei=$2`,
        [...guardians],
        imei,
      );
      for (const row of rows) allowed.add(row.guardianId);
    }
    return allowed;
  }
  async assertTracking(user: User, imei: string): Promise<void> {
    if (!(await this.canTrack(user, imei)))
      throw new ForbiddenException('This vehicle is not assigned to your active service');
  }
}
