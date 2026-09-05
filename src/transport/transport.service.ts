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
    private readonly notifications: NotificationsService,
  ) {}
  routes() {
    return this.db
      .all<Route>(
        'SELECT r.*,v.name vehicleName FROM routes r JOIN vehicles v ON v.id = r.vehicleId WHERE r.active = 1 ORDER BY r.name',
      )
      .map(route => ({
        ...route,
        stops: this.db.all<{ id: string; name: string }>(
          'SELECT id,name FROM stops WHERE routeId = ? ORDER BY rowid',
          route.id,
        ),
      }));
  }
  createRoute(actor: User, input: CreateRouteDto) {
    if (!this.db.get('SELECT id FROM vehicles WHERE id = ?', input.vehicleId))
      throw new BadRequestException('Vehicle does not exist');
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.run(
        'INSERT INTO routes (id,name,vehicleId,monthlyAmount) VALUES (?,?,?,?)',
        id,
        input.name,
        input.vehicleId,
        input.monthlyAmount,
      );
      for (const stop of input.stops)
        this.db.run('INSERT INTO stops VALUES (?,?,?)', randomUUID(), id, stop);
      this.notifications.audit(actor.id, 'ROUTE_CREATED', id);
      return this.routes().find(route => route.id === id)!;
    });
  }
  requests(user: User) {
    return this.db.all(
      `SELECT q.*,u.name guardianName,u.phone guardianPhone,r.name routeName,t.name stopName,
      v.name vehicleName FROM service_requests q JOIN users u ON u.id = q.guardianId
      JOIN routes r ON r.id = q.routeId JOIN stops t ON t.id = q.stopId JOIN vehicles v ON v.id = r.vehicleId
      WHERE (? = 'ADMIN' OR q.guardianId = ?) ORDER BY q.createdAt DESC`,
      user.role,
      user.id,
    );
  }
  subscriptions(user: User) {
    return this.db.all(
      `SELECT s.*,r.name routeName,t.name stopName,v.name vehicleName,v.id vehicleId
      FROM subscriptions s JOIN routes r ON r.id = s.routeId JOIN stops t ON t.id = s.stopId JOIN vehicles v ON v.id = r.vehicleId
      WHERE (? = 'ADMIN' OR s.guardianId = ?) ORDER BY s.startedAt DESC`,
      user.role,
      user.id,
    );
  }
  request(user: User, input: CreateServiceRequestDto) {
    return this.db.transaction(() => {
      this.assertCoverage(input.routeId, input.stopId);
      this.assertNoActiveStudent(user.id, input.studentName);
      if (
        this.db.get(
          "SELECT id FROM service_requests WHERE guardianId = ? AND studentName = ? AND status = 'PENDING'",
          user.id,
          input.studentName,
        )
      ) {
        throw new ConflictException(
          'This student already has a pending request',
        );
      }
      const id = randomUUID();
      this.db.run(
        `INSERT INTO service_requests (id,guardianId,studentName,routeId,stopId,status,createdAt) VALUES (?,?,?,?,?,'PENDING',?)`,
        id,
        user.id,
        input.studentName,
        input.routeId,
        input.stopId,
        new Date().toISOString(),
      );
      this.notifications.admins(
        'New service request',
        `${user.name} requested transport for ${input.studentName}.`,
        id,
      );
      this.notifications.audit(user.id, 'SERVICE_REQUESTED', id);
      return { id, status: 'PENDING' };
    });
  }
  reviewRequest(actor: User, id: string, input: DecisionDto) {
    this.validateDecision(input);
    return this.db.transaction(() => {
      const request = this.db.get<ServiceRequest>(
        'SELECT * FROM service_requests WHERE id = ?',
        id,
      );
      if (!request) throw new NotFoundException('Request not found');
      if (request.status !== 'PENDING')
        throw new ConflictException('This request has already been reviewed');
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED') {
        const route = this.assertCoverage(request.routeId, request.stopId);
        this.assertNoActiveStudent(request.guardianId, request.studentName);
        this.db.run(
          `INSERT INTO subscriptions (id,guardianId,requestId,studentName,routeId,stopId,monthlyAmount,status,startedAt)
          VALUES (?,?,?,?,?,?,?,'ACTIVE',?)`,
          randomUUID(),
          request.guardianId,
          id,
          request.studentName,
          request.routeId,
          request.stopId,
          route.monthlyAmount,
          now,
        );
        this.db.run(
          'UPDATE users SET verified = 1 WHERE id = ?',
          request.guardianId,
        );
      }
      this.db.run(
        'UPDATE service_requests SET status = ?,note = ?,reviewedBy = ?,reviewedAt = ? WHERE id = ?',
        input.decision,
        input.note ?? '',
        actor.id,
        now,
        id,
      );
      this.notifications.create(
        request.guardianId,
        input.decision === 'APPROVED'
          ? 'Transport service approved'
          : 'Service request rejected',
        input.decision === 'APPROVED'
          ? 'Your service is active. You can now track your assigned vehicle.'
          : input.note!,
        id,
      );
      this.notifications.audit(
        actor.id,
        `SERVICE_${input.decision}`,
        id,
        input.note,
      );
      return { id, status: input.decision };
    });
  }
  callNote(actor: User, id: string, note: string) {
    if (!this.db.get('SELECT id FROM service_requests WHERE id = ?', id))
      throw new NotFoundException('Request not found');
    this.notifications.audit(actor.id, 'GUARDIAN_CALLED', id, note);
    return { saved: true };
  }
  complaints(user: User) {
    return this.db.all(
      `SELECT c.*,u.name guardianName,s.studentName FROM complaints c
      JOIN users u ON u.id = c.guardianId JOIN subscriptions s ON s.id = c.subscriptionId
      WHERE (? = 'ADMIN' OR c.guardianId = ?) ORDER BY c.createdAt DESC`,
      user.role,
      user.id,
    );
  }
  complain(user: User, input: ComplaintDto) {
    this.assertActiveSubscription(user, input.subscriptionId);
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.run(
        'INSERT INTO complaints (id,guardianId,subscriptionId,category,description,createdAt) VALUES (?,?,?,?,?,?)',
        id,
        user.id,
        input.subscriptionId,
        input.category,
        input.description,
        new Date().toISOString(),
      );
      this.notifications.admins(
        'New complaint',
        `${user.name} submitted a transport complaint.`,
        id,
      );
      this.notifications.audit(user.id, 'COMPLAINT_SUBMITTED', id);
      return { id, status: 'OPEN' };
    });
  }
  reviewComplaint(actor: User, id: string, input: ComplaintReviewDto) {
    return this.db.transaction(() => {
      const complaint = this.db.get<{ guardianId: string }>(
        'SELECT guardianId FROM complaints WHERE id = ?',
        id,
      );
      if (!complaint) throw new NotFoundException('Complaint not found');
      if (input.status === 'RESOLVED' && !input.note?.trim())
        throw new BadRequestException('Please describe the resolution');
      this.db.run(
        'UPDATE complaints SET status = ?,note = ?,reviewedAt = ? WHERE id = ?',
        input.status,
        input.note ?? '',
        new Date().toISOString(),
        id,
      );
      this.notifications.create(
        complaint.guardianId,
        'Complaint updated',
        input.note || 'Your complaint is being reviewed.',
        id,
      );
      this.notifications.audit(
        actor.id,
        `COMPLAINT_${input.status}`,
        id,
        input.note,
      );
      return { id, status: input.status };
    });
  }
  stops(user: User) {
    return this.db.all(
      `SELECT q.*,u.name guardianName,s.studentName FROM stop_requests q
      JOIN users u ON u.id = q.guardianId JOIN subscriptions s ON s.id = q.subscriptionId
      WHERE (? = 'ADMIN' OR q.guardianId = ?) ORDER BY q.createdAt DESC`,
      user.role,
      user.id,
    );
  }
  stop(user: User, input: StopRequestDto) {
    this.assertActiveSubscription(user, input.subscriptionId);
    return this.db.transaction(() => {
      if (
        this.db.get(
          "SELECT id FROM stop_requests WHERE subscriptionId = ? AND status = 'PENDING'",
          input.subscriptionId,
        )
      )
        throw new ConflictException('A stop request is already pending');
      const id = randomUUID();
      this.db.run(
        'INSERT INTO stop_requests (id,guardianId,subscriptionId,reason,createdAt) VALUES (?,?,?,?,?)',
        id,
        user.id,
        input.subscriptionId,
        input.reason,
        new Date().toISOString(),
      );
      this.notifications.admins(
        'Stop service request',
        `${user.name} requested to stop a transport service.`,
        id,
      );
      this.notifications.audit(user.id, 'STOP_REQUESTED', id);
      return { id, status: 'PENDING' };
    });
  }
  reviewStop(actor: User, id: string, input: DecisionDto) {
    this.validateDecision(input);
    return this.db.transaction(() => {
      const request = this.db.get<{
        status: string;
        guardianId: string;
        subscriptionId: string;
      }>('SELECT * FROM stop_requests WHERE id = ?', id);
      if (!request) throw new NotFoundException('Stop request not found');
      if (request.status !== 'PENDING')
        throw new ConflictException(
          'This stop request has already been reviewed',
        );
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED')
        this.db.run(
          "UPDATE subscriptions SET status = 'STOPPED',stoppedAt = ? WHERE id = ?",
          now,
          request.subscriptionId,
        );
      this.db.run(
        'UPDATE stop_requests SET status = ?,note = ?,reviewedAt = ? WHERE id = ?',
        input.decision,
        input.note ?? '',
        now,
        id,
      );
      this.notifications.create(
        request.guardianId,
        input.decision === 'APPROVED'
          ? 'Transport service stopped'
          : 'Stop request rejected',
        input.decision === 'APPROVED'
          ? 'Your service has stopped. Previous bills remain in your payment history.'
          : input.note!,
        id,
      );
      this.notifications.audit(
        actor.id,
        `STOP_${input.decision}`,
        id,
        input.note,
      );
      return { id, status: input.decision };
    });
  }
  private assertActiveSubscription(user: User, id: string): void {
    const subscription = this.db.get<Subscription>(
      "SELECT * FROM subscriptions WHERE id = ? AND guardianId = ? AND status = 'ACTIVE'",
      id,
      user.id,
    );
    if (!subscription)
      throw new ForbiddenException('An active, approved service is required');
  }
  private assertNoActiveStudent(userId: string, studentName: string): void {
    if (
      this.db.get(
        "SELECT id FROM subscriptions WHERE guardianId = ? AND studentName = ? AND status = 'ACTIVE'",
        userId,
        studentName,
      )
    ) {
      throw new ConflictException(
        'This student already has an active transport service',
      );
    }
  }
  private assertCoverage(routeId: string, stopId: string): Route {
    const route = this.db.get<Route>(
      `SELECT r.* FROM routes r JOIN vehicles v ON v.id = r.vehicleId
      JOIN stops s ON s.routeId = r.id WHERE r.id = ? AND s.id = ? AND r.active = 1`,
      routeId,
      stopId,
    );
    if (!route)
      throw new BadRequestException(
        'This stop is not covered by an active vehicle route',
      );
    return route;
  }
  private validateDecision(input: DecisionDto): void {
    if (input.decision === 'REJECTED' && !input.note?.trim())
      throw new BadRequestException('A rejection reason is required');
  }
}
