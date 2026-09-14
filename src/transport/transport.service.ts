import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DecisionDto } from '../payments/payments.dto';
import { journeyFare } from './journey-fare';
import {
  ComplaintDto,
  ComplaintReviewDto,
  CreateRouteDto,
  CreateServiceRequestDto,
  StopRequestDto,
  RouteFaresDto,
} from './transport.dto';
interface ServiceRequest extends CreateServiceRequestDto {
  id: string;
  guardianId: string;
  status: string;
}
interface Subscription {
  id: string;
  guardianId: string;
  status: string;
}
interface Route {
  id: string;
  name: string;
  vehicleId: string;
  monthlyAmount: number;
  active: number;
}
@Injectable()
export class TransportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService
  ) {}
  async routes() {
    const routes = await this.db.all<Route>(
      `SELECT r.*,v.name "vehicleName" FROM routes r JOIN vehicles v ON v.id = r."vehicleId" WHERE r.active = 1 ORDER BY r.name`
    );
    const stops = await this.db.all<{
      id: string;
      name: string;
      routeId: string;
    }>(`SELECT id,name,"routeId" FROM stops ORDER BY position,id`);
    const stopsByRoute = new Map<string, { id: string; name: string }[]>();
    for (const stop of stops) {
      const entries = stopsByRoute.get(stop.routeId) ?? [];
      entries.push({ id: stop.id, name: stop.name });
      stopsByRoute.set(stop.routeId, entries);
    }
    const fares = await this.db.all<{ routeId: string; boardingStopId: string; dropoffStopId: string; monthlyAmount: number }>(
      `SELECT f.* FROM route_fares f JOIN stops b ON b.id=f."boardingStopId" JOIN stops d ON d.id=f."dropoffStopId"
       ORDER BY b.position,d.position,f."boardingStopId",f."dropoffStopId"`,
    );
    return routes.map((route) => ({
      ...route,
      stops: stopsByRoute.get(route.id) ?? [],
      fares: fares.filter(fare => fare.routeId === route.id).map(({ routeId, ...fare }) => fare),
    }));
  }
  async createRoute(actor: User, input: CreateRouteDto) {
    return this.transaction(async () => {
      if (
        !(await this.db.get(
          `SELECT id FROM vehicles WHERE id = $1`,
          input.vehicleId
        ))
      )
        throw new BadRequestException('Vehicle does not exist');
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO routes (id,name,"vehicleId","monthlyAmount") VALUES ($1,$2,$3,$4)`,
        id,
        input.name,
        input.vehicleId,
        input.monthlyAmount
      );
      for (const [position, stop] of input.stops.entries())
        await this.db.run(
          `INSERT INTO stops (id,"routeId",name,position) VALUES ($1,$2,$3,$4)`,
          randomUUID(),
          id,
          stop,
          position
        );
      await this.notifications.audit(actor.id, 'ROUTE_CREATED', id);
      return (await this.routes()).find((route) => route.id === id)!;
    });
  }
  async saveFares(actor: User, routeId: string, input: RouteFaresDto) {
    return this.transaction(async () => {
      if (!(await this.db.get('SELECT id FROM routes WHERE id=$1 AND active=1', routeId)))
        throw new NotFoundException('Active route not found');
      const stops = await this.db.all<{ id: string }>('SELECT id FROM stops WHERE "routeId"=$1', routeId);
      const ids = new Set(stops.map(stop => stop.id));
      const pairs = new Set<string>();
      for (const fare of input.fares) {
        if (!ids.has(fare.boardingStopId) || !ids.has(fare.dropoffStopId))
          throw new BadRequestException('Both fare stops must belong to this route');
        if (fare.boardingStopId === fare.dropoffStopId)
          throw new BadRequestException('Boarding and destination must be different stops');
        const pair = `${fare.boardingStopId}:${fare.dropoffStopId}`;
        if (pairs.has(pair)) throw new BadRequestException('Each boarding and destination pair must be unique');
        pairs.add(pair);
      }
      await this.db.run('DELETE FROM route_fares WHERE "routeId"=$1', routeId);
      for (const fare of input.fares)
        await this.db.run('INSERT INTO route_fares("routeId","boardingStopId","dropoffStopId","monthlyAmount") VALUES($1,$2,$3,$4)',
          routeId, fare.boardingStopId, fare.dropoffStopId, fare.monthlyAmount);
      await this.notifications.audit(actor.id, 'ROUTE_FARES_UPDATED', routeId,
        'Existing subscriptions and issued bills retain their assigned amounts');
      return (await this.routes()).find(route => route.id === routeId)!;
    });
  }
  async requests(user: User) {
    return await this.db.all(
      `SELECT q.*,u.name "guardianName",u.phone "guardianPhone",r.name "routeName",t.name "stopName",d.name "dropoffStopName",
      v.name "vehicleName" FROM service_requests q JOIN users u ON u.id = q."guardianId"
      JOIN routes r ON r.id = q."routeId" JOIN stops t ON t.id = q."stopId" LEFT JOIN stops d ON d.id = q."dropoffStopId" JOIN vehicles v ON v.id = r."vehicleId"
      WHERE ($1::text = 'ADMIN' OR q."guardianId" = $2) ORDER BY q."createdAt" DESC`,
      user.role,
      user.id
    );
  }
  async subscriptions(user: User) {
    return await this.db.all(
      `SELECT s.*,r.name "routeName",t.name "stopName",d.name "dropoffStopName",v.name "vehicleName",v.id "vehicleId"
      FROM subscriptions s JOIN routes r ON r.id = s."routeId" JOIN stops t ON t.id = s."stopId" LEFT JOIN stops d ON d.id = s."dropoffStopId" JOIN vehicles v ON v.id = r."vehicleId"
      WHERE ($1::text = 'ADMIN' OR s."guardianId" = $2) ORDER BY s."startedAt" DESC`,
      user.role,
      user.id
    );
  }
  async request(user: User, input: CreateServiceRequestDto) {
    return this.transaction(async () => {
      const monthlyAmount = await journeyFare(this.db, input.routeId, input.stopId, input.dropoffStopId);
      if (!input.dropoffStopId && await this.db.get('SELECT 1 FROM route_fares WHERE "routeId"=$1 LIMIT 1', input.routeId))
        throw new BadRequestException('Select a destination to use the configured journey fare');
      await this.assertNoActiveStudent(user.id, input.studentName);
      if (
        await this.db.get(
          `SELECT id FROM service_requests WHERE "guardianId" = $1 AND "studentName" = $2 AND status = 'PENDING'`,
          user.id,
          input.studentName
        )
      ) {
        throw new ConflictException(
          'This student already has a pending request'
        );
      }
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO service_requests (id,"guardianId","studentName","routeId","stopId",status,"createdAt","dropoffStopId","monthlyAmount") VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8)`,
        id,
        user.id,
        input.studentName,
        input.routeId,
        input.stopId,
        new Date().toISOString(),
        input.dropoffStopId ?? null,
        monthlyAmount
      );
      await this.db.run(`UPDATE service_requests SET "className"=$1,roll=$2,"studentCode"=$3,"photoUrl"=$4,"pickupAddress"=$5,"dropAddress"=$6,"emergencyContact"=$7 WHERE id=$8`,
        input.className??'',input.roll??'',input.studentCode??'',input.photoUrl??'',input.pickupAddress??'',input.dropAddress??'',input.emergencyContact??'',id);
      await this.notifications.admins(
        'New service request',
        `${user.name} requested transport for ${input.studentName}.`,
        id
      );
      await this.notifications.audit(user.id, 'SERVICE_REQUESTED', id);
      return { id, status: 'PENDING', monthlyAmount };
    });
  }
  async reviewRequest(actor: User, id: string, input: DecisionDto) {
    this.validateDecision(input);
    return this.transaction(async () => {
      const request = await this.db.get<ServiceRequest>(
        `SELECT * FROM service_requests WHERE id = $1`,
        id
      );
      if (!request) throw new NotFoundException('Request not found');
      if (request.status !== 'PENDING')
        throw new ConflictException('This request has already been reviewed');
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED') {
        const monthlyAmount = await journeyFare(this.db, request.routeId, request.stopId, request.dropoffStopId);
        await this.assertNoActiveStudent(
          request.guardianId,
          request.studentName
        );
        await this.db.run(
          `INSERT INTO subscriptions (id,"guardianId","requestId","studentName","routeId","stopId","monthlyAmount",status,"startedAt","dropoffStopId")
          VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9)`,
          randomUUID(),
          request.guardianId,
          id,
          request.studentName,
          request.routeId,
          request.stopId,
          monthlyAmount,
          now,
          request.dropoffStopId ?? null
        );
        await this.db.run('UPDATE service_requests SET "monthlyAmount"=$1 WHERE id=$2', monthlyAmount, id);
        await this.db.run(
          `UPDATE users SET verified = 1 WHERE id = $1`,
          request.guardianId
        );
      }
      await this.db.run(
        `UPDATE service_requests SET status = $1,note = $2,"reviewedBy" = $3,"reviewedAt" = $4 WHERE id = $5`,
        input.decision,
        input.note ?? '',
        actor.id,
        now,
        id
      );
      await this.notifications.create(
        request.guardianId,
        input.decision === 'APPROVED'
          ? 'Transport service approved'
          : 'Service request rejected',
        input.decision === 'APPROVED'
          ? 'Your service is active. You can now track your assigned vehicle.'
          : input.note!,
        id
      );
      await this.notifications.audit(
        actor.id,
        `SERVICE_${input.decision}`,
        id,
        input.note
      );
      return { id, status: input.decision };
    });
  }
  async callNote(actor: User, id: string, note: string) {
    return this.transaction(async () => {
      if (
        !(await this.db.get(
          `SELECT id FROM service_requests WHERE id = $1`,
          id
        ))
      )
        throw new NotFoundException('Request not found');
      await this.notifications.audit(actor.id, 'GUARDIAN_CALLED', id, note);
      return { saved: true };
    });
  }
  async complaints(user: User) {
    return await this.db.all(
      `SELECT c.*,u.name "guardianName",s."studentName" FROM complaints c
      JOIN users u ON u.id = c."guardianId" JOIN subscriptions s ON s.id = c."subscriptionId"
      WHERE ($1::text = 'ADMIN' OR c."guardianId" = $2) ORDER BY c."createdAt" DESC`,
      user.role,
      user.id
    );
  }
  async complain(user: User, input: ComplaintDto) {
    return this.transaction(async () => {
      await this.assertActiveSubscription(user, input.subscriptionId);
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO complaints (id,"guardianId","subscriptionId",category,description,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
        id,
        user.id,
        input.subscriptionId,
        input.category,
        input.description,
        new Date().toISOString()
      );
      await this.notifications.admins(
        'New complaint',
        `${user.name} submitted a transport complaint.`,
        id
      );
      await this.notifications.audit(user.id, 'COMPLAINT_SUBMITTED', id);
      return { id, status: 'OPEN' };
    });
  }
  async reviewComplaint(actor: User, id: string, input: ComplaintReviewDto) {
    return this.transaction(async () => {
      const complaint = await this.db.get<{ guardianId: string }>(
        `SELECT "guardianId" FROM complaints WHERE id = $1`,
        id
      );
      if (!complaint) throw new NotFoundException('Complaint not found');
      if (input.status === 'RESOLVED' && !input.note?.trim())
        throw new BadRequestException('Please describe the resolution');
      await this.db.run(
        `UPDATE complaints SET status = $1,note = $2,"reviewedAt" = $3 WHERE id = $4`,
        input.status,
        input.note ?? '',
        new Date().toISOString(),
        id
      );
      await this.notifications.create(
        complaint.guardianId,
        'Complaint updated',
        input.note || 'Your complaint is being reviewed.',
        id
      );
      await this.notifications.audit(
        actor.id,
        `COMPLAINT_${input.status}`,
        id,
        input.note
      );
      return { id, status: input.status };
    });
  }
  async stops(user: User) {
    return await this.db.all(
      `SELECT q.*,u.name "guardianName",s."studentName" FROM stop_requests q
      JOIN users u ON u.id = q."guardianId" JOIN subscriptions s ON s.id = q."subscriptionId"
      WHERE ($1::text = 'ADMIN' OR q."guardianId" = $2) ORDER BY q."createdAt" DESC`,
      user.role,
      user.id
    );
  }
  async stop(user: User, input: StopRequestDto) {
    return this.transaction(async () => {
      await this.assertActiveSubscription(user, input.subscriptionId);
      if (
        await this.db.get(
          `SELECT id FROM stop_requests WHERE "subscriptionId" = $1 AND status = 'PENDING'`,
          input.subscriptionId
        )
      )
        throw new ConflictException('A stop request is already pending');
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO stop_requests (id,"guardianId","subscriptionId",reason,"createdAt") VALUES ($1,$2,$3,$4,$5)`,
        id,
        user.id,
        input.subscriptionId,
        input.reason,
        new Date().toISOString()
      );
      await this.notifications.admins(
        'Stop service request',
        `${user.name} requested to stop a transport service.`,
        id
      );
      await this.notifications.audit(user.id, 'STOP_REQUESTED', id);
      return { id, status: 'PENDING' };
    });
  }
  async reviewStop(actor: User, id: string, input: DecisionDto) {
    this.validateDecision(input);
    return this.transaction(async () => {
      const request = await this.db.get<{
        status: string;
        guardianId: string;
        subscriptionId: string;
      }>(`SELECT * FROM stop_requests WHERE id = $1`, id);
      if (!request) throw new NotFoundException('Stop request not found');
      if (request.status !== 'PENDING')
        throw new ConflictException(
          'This stop request has already been reviewed'
        );
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED')
        await this.db.run(
          `UPDATE subscriptions SET status = 'STOPPED',"stoppedAt" = $1 WHERE id = $2`,
          now,
          request.subscriptionId
        );
      await this.db.run(
        `UPDATE stop_requests SET status = $1,note = $2,"reviewedAt" = $3 WHERE id = $4`,
        input.decision,
        input.note ?? '',
        now,
        id
      );
      await this.notifications.create(
        request.guardianId,
        input.decision === 'APPROVED'
          ? 'Transport service stopped'
          : 'Stop request rejected',
        input.decision === 'APPROVED'
          ? 'Your service has stopped. Previous bills remain in your payment history.'
          : input.note!,
        id
      );
      await this.notifications.audit(
        actor.id,
        `STOP_${input.decision}`,
        id,
        input.note
      );
      return { id, status: input.decision };
    });
  }
  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      ) {
        const constraint =
          'constraint' in error ? String(error.constraint) : '';
        const conflicts: Record<string, string> = {
          pending_service: 'This student already has a pending request',
          active_student:
            'This student already has an active transport service',
          pending_stop: 'A stop request is already pending',
        };
        if (conflicts[constraint])
          throw new ConflictException(conflicts[constraint]);
      }
      throw error;
    }
  }
  private async assertActiveSubscription(
    user: User,
    id: string
  ): Promise<void> {
    const subscription = await this.db.get<Subscription>(
      `SELECT * FROM subscriptions WHERE id = $1 AND "guardianId" = $2 AND status = 'ACTIVE'`,
      id,
      user.id
    );
    if (!subscription)
      throw new ForbiddenException('An active, approved service is required');
  }
  private async assertNoActiveStudent(
    userId: string,
    studentName: string
  ): Promise<void> {
    if (
      await this.db.get(
        `SELECT id FROM subscriptions WHERE "guardianId" = $1 AND "studentName" = $2 AND status = 'ACTIVE'`,
        userId,
        studentName
      )
    ) {
      throw new ConflictException(
        'This student already has an active transport service'
      );
    }
  }
  private validateDecision(input: DecisionDto): void {
    if (input.decision === 'REJECTED' && !input.note?.trim())
      throw new BadRequestException('A rejection reason is required');
  }
}
