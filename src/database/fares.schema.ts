/** Version 3 adds optional journeys without changing legacy fees or issued bills. */
export const faresSchema = `
ALTER TABLE stops ADD CONSTRAINT stops_route_id_unique UNIQUE ("routeId",id);
CREATE TABLE route_fares (
 "routeId" TEXT NOT NULL REFERENCES routes(id),
 "boardingStopId" TEXT NOT NULL,
 "dropoffStopId" TEXT NOT NULL,
 "monthlyAmount" INTEGER NOT NULL CHECK ("monthlyAmount" BETWEEN 1 AND 100000000),
 PRIMARY KEY ("routeId","boardingStopId","dropoffStopId"),
 FOREIGN KEY ("routeId","boardingStopId") REFERENCES stops("routeId",id),
 FOREIGN KEY ("routeId","dropoffStopId") REFERENCES stops("routeId",id),
 CHECK ("boardingStopId" <> "dropoffStopId")
);
ALTER TABLE service_requests ADD COLUMN "dropoffStopId" TEXT;
ALTER TABLE service_requests ADD COLUMN "monthlyAmount" INTEGER CHECK ("monthlyAmount" BETWEEN 1 AND 100000000);
ALTER TABLE service_requests ADD CONSTRAINT request_dropoff_route
 FOREIGN KEY ("routeId","dropoffStopId") REFERENCES stops("routeId",id);
ALTER TABLE service_requests ADD CONSTRAINT request_distinct_stops CHECK ("stopId" <> "dropoffStopId");
ALTER TABLE subscriptions ADD COLUMN "dropoffStopId" TEXT;
ALTER TABLE subscriptions ADD CONSTRAINT subscription_dropoff_route
 FOREIGN KEY ("routeId","dropoffStopId") REFERENCES stops("routeId",id);
ALTER TABLE subscriptions ADD CONSTRAINT subscription_distinct_stops CHECK ("stopId" <> "dropoffStopId");
`;
