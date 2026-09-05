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
import {
  ComplaintDto,
  ComplaintReviewDto,
  CreateRouteDto,
  CreateServiceRequestDto,
  StopRequestDto,
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
    return routes.map((route) => ({
      ...route,
      stops: stopsByRoute.get(route.id) ?? [],
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
  async requests(user: User) {
    return await this.db.all(
      `SELECT q.*,u.name "guardianName",u.phone "guardianPhone",r.name "routeName",t.name "stopName",
      v.name "vehicleName" FROM service_requests q JOIN users u ON u.id = q."guardianId"
      JOIN routes r ON r.id = q."routeId" JOIN stops t ON t.id = q."stopId" JOIN vehicles v ON v.id = r."vehicleId"
      WHERE ($1::text = 'ADMIN' OR q."guardianId" = $2) ORDER BY q."createdAt" DESC`,
      user.role,
      user.id
    );
  }
  async subscriptions(user: User) {
    return await this.db.all(
      `SELECT s.*,r.name "routeName",t.name "stopName",v.name "vehicleName",v.id "vehicleId"
      FROM subscriptions s JOIN routes r ON r.id = s."routeId" JOIN stops t ON t.id = s."stopId" JOIN vehicles v ON v.id = r."vehicleId"
      WHERE ($1::text = 'ADMIN' OR s."guardianId" = $2) ORDER BY s."startedAt" DESC`,
      user.role,
      user.id
    );
  }
  async request(user: User, input: CreateServiceRequestDto) {
    return this.transaction(async () => {
      await this.assertCoverage(input.routeId, input.stopId);
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
        `INSERT INTO service_requests (id,"guardianId","studentName","routeId","stopId",status,"createdAt") VALUES ($1,$2,$3,$4,$5,'PENDING',$6)`,
        id,
        user.id,
        input.studentName,
        input.routeId,
        input.stopId,
        new Date().toISOString()
      );
      await this.notifications.admins(
        'New service request',
        `${user.name} requested transport for ${input.studentName}.`,
        id
      );
      await this.notifications.audit(user.id, 'SERVICE_REQUESTED', id);
      return { id, status: 'PENDING' };
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
        const route = await this.assertCoverage(
          request.routeId,
          request.stopId
        );
        await this.assertNoActiveStudent(
          request.guardianId,
          request.studentName
        );
        await this.db.run(
          `INSERT INTO subscriptions (id,"guardianId","requestId","studentName","routeId","stopId","monthlyAmount",status,"startedAt")
          VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8)`,
          randomUUID(),
          request.guardianId,
          id,
          request.studentName,
          request.routeId,
          request.stopId,
          route.monthlyAmount,
          now
        );
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
  private async assertCoverage(
    routeId: string,
    stopId: string
  ): Promise<Route> {
    const route = await this.db.get<Route>(
      `SELECT r.* FROM routes r JOIN vehicles v ON v.id = r."vehicleId"
      JOIN stops s ON s."routeId" = r.id WHERE r.id = $1 AND s.id = $2 AND r.active = 1`,
      routeId,
      stopId
    );
    if (!route)
      throw new BadRequestException(
        'This stop is not covered by an active vehicle route'
      );
    return route;
  }
  private validateDecision(input: DecisionDto): void {
    if (input.decision === 'REJECTED' && !input.note?.trim())
      throw new BadRequestException('A rejection reason is required');
  }
}
