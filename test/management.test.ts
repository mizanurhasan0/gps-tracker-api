import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { schema as versionOne } from '../src/database/schema';

const databaseUrl=process.env.TEST_DATABASE_URL??process.env.HISTORY_TEST_DATABASE_URL;
type Row=Record<string,any>;

test('management PostgreSQL HTTP integration and version 1 upgrade',{skip:!databaseUrl},async(t)=>{
  const schema=`management_${randomUUID().replaceAll('-','')}`;
  const setup=new Pool({connectionString:databaseUrl});
  await setup.query(`CREATE SCHEMA ${schema}`);
  const isolated=new URL(databaseUrl!);
  isolated.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:isolated.toString()});
  const legacy={guardian:randomUUID(),vehicle:randomUUID(),route:randomUUID(),stop:randomUUID(),request:randomUUID(),student:randomUUID()};
  await pool.query(versionOne);
  await pool.query('CREATE TABLE app_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO app_migrations(version) VALUES(1)');
  await pool.query(`INSERT INTO users VALUES($1,'Existing guardian','01711111111','legacy-hash','GUARDIAN',1,$2)`,[legacy.guardian,new Date().toISOString()]);
  await pool.query(`INSERT INTO vehicles(id,name,plate,imei,"driverName","driverPhone","createdAt","updatedAt") VALUES($1,'Legacy van','OLD-01','868720065798370','Legacy driver','01711111112',$2,$2)`,[legacy.vehicle,new Date().toISOString()]);
  await pool.query(`INSERT INTO routes(id,name,"vehicleId","monthlyAmount") VALUES($1,'Legacy route',$2,250000)`,[legacy.route,legacy.vehicle]);
  await pool.query(`INSERT INTO stops(id,"routeId",name) VALUES($1,$2,'Legacy stop')`,[legacy.stop,legacy.route]);
  await pool.query(`INSERT INTO service_requests(id,"guardianId","studentName","routeId","stopId",status,"createdAt") VALUES($1,$2,'Existing child',$3,$4,'APPROVED',$5)`,[legacy.request,legacy.guardian,legacy.route,legacy.stop,new Date().toISOString()]);
  await pool.query(`INSERT INTO subscriptions(id,"guardianId","requestId","studentName","routeId","stopId","monthlyAmount",status,"startedAt") VALUES($1,$2,$3,'Existing child',$4,$5,250000,'ACTIVE',$6)`,[legacy.student,legacy.guardian,legacy.request,legacy.route,legacy.stop,new Date().toISOString()]);
  process.env.DATABASE_URL=isolated.toString();
  process.env.ADMIN_PHONE='01700000001';process.env.ADMIN_PASSWORD='management-admin-pass';
  const {SecurityModule}=require('../dist/auth/security.module');
  const {TransportModule}=require('../dist/transport/transport.module');
  const {VehiclesModule}=require('../dist/vehicles/vehicles.module');
  const {DatabaseService}=require('../dist/database/database.service');
  class TestApp {}
  Module({imports:[SecurityModule,TransportModule,VehiclesModule]})(TestApp);
  const app=await NestFactory.create<NestExpressApplication>(TestApp,{logger:false});
  app.useBodyParser('json',{limit:'768kb'});
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
  await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();const db=app.get(DatabaseService);
  t.after(async()=>{await app.close();await pool.end();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.end();});
  async function request(path:string,token?:string,body?:unknown,method='GET',status=200):Promise<any>{
    const response=await fetch(`${origin}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=response.status===204?undefined:await response.json();
    assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`);return data;
  }
  const admin=await request('/auth/login',undefined,{phone:process.env.ADMIN_PHONE,password:process.env.ADMIN_PASSWORD},'POST');
  const guardian=await request('/auth/register',undefined,{name:'Guardian A',phone:'01700000002',password:'guardian-password'},'POST',201);
  const other=await request('/auth/register',undefined,{name:'Guardian B',phone:'01700000003',password:'guardian-password'},'POST',201);
  let vehicle:Row,route:Row,student:Row,secondStudent:Row,driver:Row,maintenance:Row;

  await t.test('upgrades real version 1 data and backfills student and driver IDs',async()=>{
    assert.deepEqual(await db.all('SELECT version FROM app_migrations ORDER BY version'),[{version:1},{version:2},{version:3},{version:4}]);
    const migratedService=await db.get('SELECT * FROM subscriptions WHERE id=$1',legacy.student);
    assert.equal(migratedService.shiftId,'MORNING');
    assert.deepEqual(migratedService.operatingDays,[0,1,2,3,4,5,6]);
    assert.equal(migratedService.studentId,(await db.get('SELECT "studentId" FROM service_requests WHERE id=$1',legacy.request)).studentId);
    assert.deepEqual((await request('/management/overview',admin.token)).settings.operatingDays,[0,1,2,3,4,5,6]);
    const overview=await request('/management/overview',admin.token);
    assert.equal(overview.students[0].id,legacy.student);
    assert.equal(overview.students[0].subscriptionId,legacy.student);
    assert.equal(overview.students[0].monthlyAmount,250000);
    assert.equal(overview.students[0].dropoffStopId,null);
    assert.equal((await request('/routes',admin.token))[0].fares.length,0);
    assert.equal(overview.drivers[0].vehicleId,legacy.vehicle);
    await db.ensureReady();
    assert.equal((await db.all('SELECT * FROM students')).length,1);
  });
  await t.test('requires authentication, admin writes, valid dates and validated payloads',async()=>{
    await request('/management/overview',undefined,undefined,'GET',401);
    for(const path of ['/admin/students','/admin/drivers','/admin/ledger','/admin/notices','/admin/maintenance'])
      await request(path,guardian.token,{},'POST',403);
    await request('/admin/settings',guardian.token,{},'PATCH',403);
    await request('/admin/reports?month=2026-13',admin.token,undefined,'GET',400);
    await request('/admin/reports',guardian.token,undefined,'GET',403);
    await request('/admin/ledger',admin.token,{type:'EXPENSE',category:'FUEL',title:'Fuel',amount:0,date:'2026-09-10'},'POST',400);
    await request('/admin/ledger',admin.token,{type:'EXPENSE',category:'FUEL',title:'Fuel',amount:100,date:'2026-02-30'},'POST',400);
    await request('/admin/settings',admin.token,{adminPassword:'unsafe'},'PATCH',400);
    await request('/admin/settings',admin.token,{businessName:null},'PATCH',400);
  });
  await t.test('persists vehicle metadata and student enrollment against registered guardians',async()=>{
    vehicle=await request('/vehicles',admin.token,{name:'গাড়ি-০১',plate:'DHAKA-1234',imei:'868720065798371',model:'School van',purchaseDate:'2022-01-10',fitnessExpiresAt:'2027-01-01',licenseExpiresAt:'2027-09-01',status:'RUNNING'},'POST',201);
    assert.equal(vehicle.model,'School van');
    route=await request('/admin/routes',admin.token,{name:'Southkhan',vehicleId:vehicle.id,monthlyAmount:250000,stops:['Pickup A','Pickup B']},'POST',201);
    await request('/admin/students',admin.token,{studentName:'Invalid guardian child',guardianPhone:'01200000999',routeId:route.id,stopId:route.stops[0].id},'POST',400);
    // Force a serialization retry after the generated IDs exist: retry must still create, not update.
    await db.exec(`CREATE SEQUENCE student_retry_once; CREATE FUNCTION student_retry_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('student_retry_once')=1 THEN RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER student_retry_once BEFORE INSERT ON students FOR EACH ROW EXECUTE FUNCTION student_retry_once()`);
    try {
      student=await request('/admin/students',admin.token,{studentName:'Abdullah',guardianPhone:guardian.user.phone,routeId:route.id,stopId:route.stops[0].id,className:'Class 6',roll:'21',pickupAddress:'Uttara',emergencyContact:'01700000004',photoUrl:'data:image/jpeg;base64,'+'A'.repeat(150000)},'POST',201);
    } finally {
      await db.exec('DROP TRIGGER student_retry_once ON students; DROP FUNCTION student_retry_once(); DROP SEQUENCE student_retry_once');
    }
    assert.equal(student.className,'Class 6');assert.equal(student.monthlyAmount,250000);assert.equal(student.guardianId,guardian.user.id);
    assert.equal((await request('/requests/mine',guardian.token))[0].className,'Class 6');
    await request(`/admin/students/${student.id}`,admin.token,{guardianPhone:other.user.phone},'PATCH',400);
    await request(`/admin/students/${student.id}`,admin.token,{photoUrl:'file:///private/secret'},'PATCH',400);
    await request(`/admin/students/${student.id}`,admin.token,{photoUrl:'data:image/svg+xml;base64,AAAA'},'PATCH',400);
    await request(`/admin/students/${student.id}`,admin.token,{photoUrl:'data:image/png;base64,'+'A'.repeat(450001)},'PATCH',400);
    const updated=await request(`/admin/students/${student.id}`,admin.token,{roll:'22',monthlyAmount:260000},'PATCH');
    assert.equal(updated.roll,'22');assert.equal(updated.monthlyAmount,260000);
  });
  await t.test('vehicle metadata accepts cleared dates while rejecting malformed nonempty dates',async()=>{
    const cleared=await request(`/vehicles/${vehicle.id}`,admin.token,{model:'Updated van',purchaseDate:'',fitnessExpiresAt:'',licenseExpiresAt:''},'PATCH');
    assert.equal(cleared.model,'Updated van');
    for(const field of ['purchaseDate','fitnessExpiresAt','licenseExpiresAt']) assert.equal(cleared[field],'');
    const persisted=await request(`/vehicles/${vehicle.id}`,admin.token);
    assert.equal(persisted.model,'Updated van');assert.equal(persisted.purchaseDate,'');assert.equal(persisted.fitnessExpiresAt,'');assert.equal(persisted.licenseExpiresAt,'');
    const fresh=await request(`/vehicles/${legacy.vehicle}`,admin.token,{model:'Legacy updated',purchaseDate:'',fitnessExpiresAt:'',licenseExpiresAt:''},'PATCH');
    assert.equal(fresh.model,'Legacy updated');
    for(const field of ['purchaseDate','fitnessExpiresAt','licenseExpiresAt']) {
      for(const value of ['2026-02-30','2026-1-01','2026-09-10T10:00:00Z',' '])
        await request(`/vehicles/${vehicle.id}`,admin.token,{[field]:value},'PATCH',400);
    }
    assert.equal((await request(`/vehicles/${vehicle.id}`,admin.token)).model,'Updated van');
  });
  await t.test('guardian admission profile fields survive approval and cannot override fare or ownership',async()=>{
    await request('/requests/guardian/new',other.token,{studentName:'Ayesha',routeId:route.id,stopId:route.stops[1].id,monthlyAmount:1},'POST',400);
    const admission=await request('/requests/guardian/new',other.token,{studentName:'Ayesha',routeId:route.id,stopId:route.stops[1].id,className:'Class 5',roll:'9',pickupAddress:'Sector 8',dropAddress:'Madrasa'},'POST',201);
    await request(`/admin/requests/${admission.id}/decision`,admin.token,{decision:'APPROVED'},'PATCH');
    const overview=await request('/management/overview',other.token);
    assert.equal(overview.students.length,1);secondStudent=overview.students[0];
    assert.equal(secondStudent.className,'Class 5');assert.equal(secondStudent.roll,'9');assert.equal(secondStudent.monthlyAmount,250000);
    assert.equal(secondStudent.pickupAddress,'Sector 8');
  });
  await t.test('driver assignment persists and guardian projection omits private employment information',async()=>{
    driver=await request('/admin/drivers',admin.token,{name:'Nur Alam',phone:'01700000005',nid:'1234567890',address:'Dhaka',joiningDate:'2025-01-12',monthlySalary:1200000,vehicleId:vehicle.id},'POST',201);
    assert.equal(driver.vehicleName,'গাড়ি-০১');
    const assigned=await request(`/vehicles/${vehicle.id}`,admin.token);assert.equal(assigned.driverName,'Nur Alam');
    await request('/admin/drivers',admin.token,{name:'Second driver',phone:'01700000006',vehicleId:vehicle.id},'POST',409);
    const overview=await request('/management/overview',guardian.token);
    assert.equal(overview.drivers.length,1);assert.equal(overview.drivers[0].nid,'');assert.equal(overview.drivers[0].monthlySalary,0);
    assert.equal(overview.students.length,1);assert.equal(overview.students[0].id,student.id);
    assert.deepEqual(overview.ledger,[]);assert.deepEqual(overview.maintenance,[]);
  });
  await t.test('attendance is an atomic upsert and validates every referenced person',async()=>{
    const entry={studentId:student.id,date:'2026-09-10',status:'PRESENT'};
    await request('/admin/attendance',admin.token,{entries:[entry,{driverId:driver.id,date:'2026-09-10',status:'ABSENT'}]},'PUT');
    await request('/admin/attendance',admin.token,{entries:[{...entry,status:'ABSENT'}]},'PUT');
    assert.equal((await request('/management/overview',guardian.token)).attendance.length,1);
    await request('/admin/attendance',admin.token,{entries:[{...entry,status:'PRESENT'},{studentId:randomUUID(),date:'2026-09-10',status:'PRESENT'}]},'PUT',404);
    assert.equal((await request('/management/overview',guardian.token)).attendance[0].status,'ABSENT');
    await request('/admin/attendance',admin.token,{entries:[entry,entry]},'PUT',400);
    await request('/admin/attendance',admin.token,{entries:[{...entry,driverId:driver.id}]},'PUT',400);
  });
  await t.test('maintenance costs update exactly one expense and roll back on downstream failure',async()=>{
    maintenance=await request('/admin/maintenance',admin.token,{vehicleId:vehicle.id,title:'Oil change',serviceDate:'2026-09-10',nextServiceDate:'2026-10-01',amount:50000,status:'IN_PROGRESS'},'POST',201);
    assert.equal((await request(`/vehicles/${vehicle.id}`,admin.token)).status,'MAINTENANCE');
    assert.equal((await request('/management/overview',admin.token)).ledger.length,0);
    await request(`/admin/maintenance/${maintenance.id}`,admin.token,{status:'COMPLETED'},'PATCH');
    await request(`/admin/maintenance/${maintenance.id}`,admin.token,{amount:60000},'PATCH');
    const overview=await request('/management/overview',admin.token);assert.equal(overview.ledger.length,1);assert.equal(overview.ledger[0].amount,60000);
    assert.equal((await request(`/vehicles/${vehicle.id}`,admin.token)).status,'RUNNING');
    await db.exec(`CREATE FUNCTION fail_management_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$;
      CREATE TRIGGER fail_management_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_management_audit()`);
    try { await request(`/admin/maintenance/${maintenance.id}`,admin.token,{amount:70000},'PATCH',500); }
    finally { await db.exec('DROP TRIGGER fail_management_audit ON audit_logs; DROP FUNCTION fail_management_audit()'); }
    assert.equal((await request('/management/overview',admin.token)).ledger[0].amount,60000);
    assert.equal((await request('/management/overview',admin.token)).maintenance[0].amount,60000);
  });
  await t.test('notices are delivered only to their explicit recipient snapshot',async()=>{
    const notice=await request('/admin/notices',admin.token,{title:'Payment reminder',body:'Please pay your fare',category:'PAYMENT',audience:'STUDENT',targetId:student.id},'POST',201);
    assert.equal(notice.recipientCount,1);
    assert.equal((await request('/management/overview',guardian.token)).notices.length,1);
    assert.equal((await request('/management/overview',other.token)).notices.length,0);
    assert.ok((await request('/notifications',guardian.token)).some((n:Row)=>n.entityId===notice.id));
    await request('/admin/notices',admin.token,{title:'Bad target',body:'Wrong target',category:'OTHER',audience:'ROUTE',targetId:student.id},'POST',404);
  });
  await t.test('requests enforce guardian ownership and approved absence records attendance',async()=>{
    await request('/management/requests',other.token,{studentId:student.id,category:'ABSENCE',title:'Absence',description:'Away for one day',date:'2026-09-11'},'POST',403);
    await request('/management/requests',guardian.token,{studentId:student.id,vehicleId:vehicle.id,category:'OTHER',title:'Vehicle',description:'Details here'},'POST',403);
    const item=await request('/management/requests',guardian.token,{studentId:student.id,category:'ABSENCE',title:'Absence',description:'Away for one day',date:'2026-09-11'},'POST',201);
    await request('/management/requests',guardian.token,{studentId:student.id,category:'ABSENCE',title:'Absence again',description:'Duplicate request for same date',date:'2026-09-11'},'POST',409);
    await request(`/admin/management-requests/${item.id}/decision`,admin.token,{decision:'APPROVED'},'PATCH');
    await request(`/admin/management-requests/${item.id}/decision`,admin.token,{decision:'APPROVED'},'PATCH',409);
    assert.equal((await request('/management/overview',other.token)).requests.length,0);
    const overview=await request('/management/overview',guardian.token);
    assert.equal(overview.requests[0].status,'APPROVED');assert.ok(overview.attendance.some((a:Row)=>a.date==='2026-09-11'&&a.status==='ABSENT'));
  });
  await t.test('route schedules are atomic and hide other students and stops',async()=>{
    const entries=[{studentId:student.id,stopId:route.stops[0].id,label:'Abdullah pickup',time:'06:00',period:'MORNING',position:0},
      {studentId:secondStudent.id,stopId:route.stops[1].id,label:'Ayesha pickup',time:'06:05',period:'MORNING',position:1},
      {studentId:null,stopId:null,label:'Madrasa arrival',time:'06:25',period:'MORNING',position:2}];
    await request(`/admin/routes/${route.id}/schedule`,admin.token,{entries},'PUT');
    const own=(await request('/management/overview',guardian.token)).schedules;assert.equal(own.length,2);assert.ok(!own.some((s:Row)=>s.label.includes('Ayesha')));
    await request(`/admin/routes/${route.id}/schedule`,admin.token,{entries:[{...entries[0],stopId:legacy.stop}]},'PUT',400);
    assert.equal((await request('/management/overview',guardian.token)).schedules.length,2);
  });
  await t.test('settings persist and reports separate investment from revenue and reconcile expenses',async()=>{
    await request('/admin/settings',admin.token,{phone:'01700000007',businessName:'Noor Transport',emergencyPhone:'01700000008'},'PATCH');
    assert.equal((await request('/management/overview',guardian.token)).settings.emergencyPhone,'01700000008');
    await request('/admin/ledger',admin.token,{type:'INCOME',category:'OTHER',title:'Other revenue',amount:200000,date:'2026-09-10'},'POST',201);
    await request('/admin/ledger',admin.token,{type:'INVESTMENT',category:'CAPITAL',title:'Owner capital',amount:900000,date:'2026-09-10'},'POST',201);
    await request('/admin/ledger',admin.token,{type:'EXPENSE',category:'FUEL',title:'Fuel',amount:40000,date:'2026-09-10',vehicleId:vehicle.id},'POST',201);
    const report=await request('/admin/reports?month=2026-09',admin.token);
    assert.deepEqual(report.cashflow,{fareReceived:0,otherIncome:200000,expenses:100000,investment:900000,net:100000});
    assert.equal(report.students.total,3);assert.equal(report.ledger.length,4);
  });
  await t.test('stopping a student revokes their assigned operational projection',async()=>{
    await request(`/admin/students/${student.id}`,admin.token,{status:'STOPPED'},'PATCH');
    const overview=await request('/management/overview',guardian.token);
    assert.equal(overview.students[0].status,'STOPPED');assert.deepEqual(overview.drivers,[]);assert.deepEqual(overview.schedules,[]);
    assert.equal(overview.students[0].driverName,null);assert.equal(overview.students[0].driverPhone,null);
    assert.equal(overview.attendance.length,2,'historical attendance stays available');
    assert.deepEqual(await request('/vehicles',guardian.token),{vehicles:[]});
    await request(`/admin/students/${student.id}`,admin.token,{status:'ACTIVE'},'PATCH',400);
    assert.equal((await request('/management/overview',guardian.token)).students[0].status,'STOPPED');
  });
  await t.test('fare changes preserve earlier unbilled periods and stopped fee snapshots',async()=>{
    await request(`/admin/students/${student.id}`,admin.token,{monthlyAmount:1},'PATCH',400);
    const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit'}).format(new Date());
    const [year,month]=current.split('-').map(Number);
    const previousMonth=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
    await db.run('UPDATE subscriptions SET "startedAt"=$1 WHERE id=$2',`${previousMonth}-10T00:00:00.000Z`,legacy.student);
    await request(`/admin/students/${legacy.student}`,admin.token,{monthlyAmount:300000},'PATCH',409);
    await request('/admin/bills/generate',admin.token,{month:previousMonth},'POST',201);
    await request(`/admin/students/${legacy.student}`,admin.token,{monthlyAmount:300000},'PATCH');
    const bills=await request(`/payments/monthly?month=${previousMonth}`,admin.token);
    assert.equal(bills.find((bill:Row)=>bill.subscriptionId===legacy.student).amount,250000);
  });
});
