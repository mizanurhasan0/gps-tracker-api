import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { User } from './auth.types';
@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}
  async canTrack(user: User, imei: string): Promise<boolean> {
    return (
      user.role === 'ADMIN' ||
      Boolean(
        await this.db.get(
          `SELECT s.id FROM subscriptions s
      JOIN routes r ON r.id = s."routeId" JOIN vehicles v ON v.id = r."vehicleId"
      WHERE s."guardianId" = $1 AND s.status = 'ACTIVE' AND r.active = 1 AND v.imei = $2`,
          user.id,
          imei
        )
      )
    );
  }
  async assertTracking(user: User, imei: string): Promise<void> {
    if (!(await this.canTrack(user, imei)))
      throw new ForbiddenException(
        'This vehicle is not assigned to your active service'
      );
  }
}
