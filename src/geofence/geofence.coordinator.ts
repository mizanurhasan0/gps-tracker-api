import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appConfig } from '../config/app.config';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { SavedPosition } from '../locations/location.types';
import { LocationsService } from '../locations/locations.service';
import {
  DEFAULT_GEOFENCE_CONFIG,
  GeofenceService,
} from './geofence.service';
import type { RouteStopCoordinate } from './geofence.types';

interface Assignment {
  subscriptionId: string;
  guardianId: string;
  studentName: string;
  routeId: string;
  routeName: string;
  vehicleId: string;
  stopId: string;
  stopName: string;
  shiftId: string;
}

interface SettingsRow {
  data: {
    transportShifts?: Array<{
      id: string;
      startTime: string;
      endTime: string;
    }>;
  };
}

interface TripRow {
  id: string;
}

interface StateRow {
  state: 'OUTSIDE' | 'INSIDE';
  entryCount: number;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastDistanceMeters: number | null;
  lastEnteredAt: string | null;
  lastEventKey: string | null;
}

/** Connects committed GPS fixes to route assignments and private notifications. */
@Injectable()
export class GeofenceCoordinator
  implements OnModuleInit, OnApplicationShutdown
{
  private unregister?: () => void;
  private readonly evaluator: GeofenceService;

  constructor(
    private readonly db: DatabaseService,
    private readonly locations: LocationsService,
    private readonly notifications: NotificationsService,
  ) {
    this.evaluator = new GeofenceService(
      { findStopCoordinate: (routeId, stopId) => this.findStopCoordinate(routeId, stopId) },
      {
        enterRadiusMeters: appConfig.telegram.geofenceRadiusMeters,
        exitRadiusMeters: Math.max(
          appConfig.telegram.geofenceRadiusMeters * 1.5,
          DEFAULT_GEOFENCE_CONFIG.exitRadiusMeters,
        ),
      },
    );
  }

  onModuleInit(): void {
    this.unregister = this.locations.registerPositionEvaluationHook(
      position => this.evaluate(position),
    );
  }

  onApplicationShutdown(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  private async evaluate(position: SavedPosition): Promise<void> {
    if (!appConfig.telegram.enabled) return;

    const assignments = await this.db.all<Assignment>(
      `SELECT s.id AS "subscriptionId", s."guardianId", s."studentName",
          s."routeId", r.name AS "routeName", r."vehicleId", s."stopId",
          st.name AS "stopName", s."shiftId"
       FROM subscriptions s
       JOIN routes r ON r.id = s."routeId" AND r.active = 1 AND r."vehicleId" = (
         SELECT id FROM vehicles WHERE imei = $1
       )
       JOIN stops st ON st.id = s."stopId" AND st."routeId" = s."routeId"
       WHERE s.status = 'ACTIVE'
         AND s."operatingDays" @> ARRAY[
           EXTRACT(DOW FROM (now() AT TIME ZONE 'Asia/Dhaka'))::integer
         ]`,
      position.imei,
    );
    const settings = await this.db.get<SettingsRow>(
      'SELECT data FROM business_settings WHERE id=1',
    );
    const eligible = assignments.filter(assignment =>
      this.isShiftWindow(assignment.shiftId, position.receivedAt, settings),
    );

    const grouped = new Map<string, Assignment[]>();
    for (const assignment of eligible) {
      const key = `${assignment.routeId}:${assignment.vehicleId}:${assignment.shiftId}:${assignment.stopId}`;
      const current = grouped.get(key) ?? [];
      current.push(assignment);
      grouped.set(key, current);
    }

    for (const stopAssignments of grouped.values()) {
      await this.evaluateStop(position, stopAssignments);
    }
  }

  private async evaluateStop(
    position: SavedPosition,
    assignments: Assignment[],
  ): Promise<void> {
    const first = assignments[0];
    const serviceDate = this.dhakaDate(position.receivedAt);
    const trip = await this.db.get<TripRow>(
      `INSERT INTO geofence_trips
         (id,"routeId","vehicleId","shiftId","serviceDate",status,"startedAt")
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)
       ON CONFLICT ("routeId","vehicleId","shiftId","serviceDate")
       DO UPDATE SET status='ACTIVE'
       RETURNING id`,
      randomUUID(),
      first.routeId,
      first.vehicleId,
      first.shiftId,
      serviceDate,
      position.receivedAt,
    );
    if (!trip) return;

    const state = await this.db.transaction(async () => {
      const previous = await this.db.get<StateRow>(
        `SELECT state,"entryCount", "lastLatitude", "lastLongitude",
            "lastDistanceMeters", "lastEnteredAt"
         FROM geofence_trip_states
         WHERE "tripId"=$1 AND "pickupPointId"=$2 FOR UPDATE`,
        trip.id,
        first.stopId,
      );
      const result = await this.evaluator.evaluate({
        tripId: trip.id,
        routeId: first.routeId,
        stopId: first.stopId,
        vehiclePosition: position,
        previousState: previous
          ? {
              tripId: trip.id,
              routeId: first.routeId,
              stopId: first.stopId,
              phase: previous.state === 'INSIDE' ? 'inside' : 'outside',
              notificationSent: previous.entryCount > 0,
            }
          : undefined,
      });
      if (result.status !== 'evaluated' || !result.state) return result;

      const entryCount = result.transition === 'enter'
        ? (previous?.entryCount ?? 0) + 1
        : previous?.entryCount ?? 0;
      const eventKey = `pickup:${trip.id}:${first.stopId}:${entryCount}`;
      const enteredAt = result.transition === 'enter'
        ? new Date().toISOString()
        : previous?.lastEnteredAt ?? null;
      const transitionAt = result.transition === 'none'
        ? null
        : new Date().toISOString();
      await this.db.run(
        `INSERT INTO geofence_trip_states
           ("tripId","pickupPointId",state,"entryCount","lastLatitude",
            "lastLongitude","lastDistanceMeters","lastTransitionAt",
            "lastEnteredAt","lastEventKey","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT ("tripId","pickupPointId") DO UPDATE SET
           state=EXCLUDED.state,"entryCount"=EXCLUDED."entryCount",
           "lastLatitude"=EXCLUDED."lastLatitude",
           "lastLongitude"=EXCLUDED."lastLongitude",
           "lastDistanceMeters"=EXCLUDED."lastDistanceMeters",
           "lastTransitionAt"=EXCLUDED."lastTransitionAt",
           "lastEnteredAt"=EXCLUDED."lastEnteredAt",
           "lastEventKey"=EXCLUDED."lastEventKey", "updatedAt"=now()`,
        trip.id,
        first.stopId,
        result.state.phase === 'inside' ? 'INSIDE' : 'OUTSIDE',
        entryCount,
        position.latitude,
        position.longitude,
        result.distanceMeters,
        transitionAt,
        enteredAt,
        eventKey,
      );
      return {
        ...result,
        eventKey,
      };
    });

    if (
      state.status !== 'evaluated' ||
      state.transition !== 'enter' ||
      !state.shouldNotify ||
      !('eventKey' in state)
    )
      return;

    for (const assignment of assignments) {
      await this.notifications.create(
        assignment.guardianId,
        '🚌 Pickup alert',
        `The bus is approaching ${assignment.stopName} for ${assignment.studentName}.`,
        state.eventKey,
      );
    }
  }

  private async findStopCoordinate(
    routeId: string,
    stopId: string,
  ): Promise<RouteStopCoordinate | null> {
    const row = await this.db.get<RouteStopCoordinate>(
      `SELECT s."routeId", p."stopId", p.latitude, p.longitude
       FROM pickup_points p
       JOIN stops s ON s.id = p."stopId"
       WHERE s."routeId" = $1 AND p."stopId" = $2 AND p.active = TRUE`,
      routeId,
      stopId,
    );
    return row ?? null;
  }

  private dhakaDate(value: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
  }

  private isShiftWindow(
    shiftId: string,
    timestamp: string,
    settings?: SettingsRow,
  ): boolean {
    const shift = settings?.data.transportShifts?.find(item => item.id === shiftId);
    // Legacy installations may not have configured shift times. Operating-day
    // filtering still applies, and the alert remains useful in that case.
    if (!shift) return true;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    const current = hour * 60 + minute;
    const parse = (value: string) => {
      const [h, m] = value.split(':').map(Number);
      return h * 60 + m;
    };
    const window = appConfig.telegram.geofenceTimeWindowMinutes;
    return current >= parse(shift.startTime) - window &&
      current <= parse(shift.endTime) + window;
  }
}
