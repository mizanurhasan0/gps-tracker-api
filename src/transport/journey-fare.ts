import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** Prices are integer poisha. Destination journeys never fall back to a flat fee. */
export async function journeyFare(
  db: DatabaseService,
  routeId: string,
  boardingStopId: string,
  dropoffStopId: string | null | undefined,
): Promise<number> {
  const route = await db.get<{ monthlyAmount: number }>(
    `SELECT r."monthlyAmount" FROM routes r JOIN vehicles v ON v.id=r."vehicleId"
     JOIN stops s ON s."routeId"=r.id WHERE r.id=$1 AND s.id=$2 AND r.active=1`,
    routeId, boardingStopId,
  );
  if (!route) throw new BadRequestException('Select a boarding stop on an active vehicle route');
  if (!dropoffStopId) return route.monthlyAmount;
  if (boardingStopId === dropoffStopId)
    throw new BadRequestException('Boarding and destination must be different stops');
  const fare = await db.get<{ monthlyAmount: number }>(
    `SELECT "monthlyAmount" FROM route_fares WHERE "routeId"=$1 AND "boardingStopId"=$2 AND "dropoffStopId"=$3`,
    routeId, boardingStopId, dropoffStopId,
  );
  if (!fare) throw new BadRequestException('No fare is configured for this boarding and destination pair');
  return fare.monthlyAmount;
}
