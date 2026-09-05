import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { User } from './auth.types';
@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}
  canTrack(user: User, imei: string): boolean {
    return (
      user.role === 'ADMIN' ||
      Boolean(
        this.db.get(
          `SELECT s.id FROM subscriptions s
      JOIN routes r ON r.id = s.routeId JOIN vehicles v ON v.id = r.vehicleId
      WHERE s.guardianId = ? AND s.status = 'ACTIVE' AND r.active = 1 AND v.imei = ?`,
          user.id,
          imei,
        ),
      )
    );
  }
  assertTracking(user: User, imei: string): void {
    if (!this.canTrack(user, imei))
      throw new ForbiddenException(
        'This vehicle is not assigned to your active service',
      );
  }
}
