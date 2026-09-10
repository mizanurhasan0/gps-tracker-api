import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DecisionDto } from '../payments/payments.dto';
import { AttendanceBatchDto, CreateDriverDto, CreateLedgerDto, CreateMaintenanceDto, CreateManagementRequestDto, CreateNoticeDto, CreateStudentDto, ScheduleDto, SettingsDto, UpdateDriverDto, UpdateMaintenanceDto, UpdateStudentDto } from './management.dto';

const profileFields = ['studentCode','className','roll','photoUrl','pickupAddress','dropAddress','emergencyContact'] as const;
type Row = Record<string, any>;
const now = () => new Date().toISOString();

@Injectable()
export class ManagementService {
  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}

  async overview(user: User) {
    const isAdmin = user.role === 'ADMIN';
    const students = await this.students(user);
    const [drivers, attendance, maintenance, ledger, notices, requests, settings, schedules] = await Promise.all([
      isAdmin ? this.drivers() : this.db.all(`SELECT d.id,d.name,d.phone,d.status,d."vehicleId",v.name "vehicleName",
        ''::text nid,''::text address,''::text "joiningDate",0 "monthlySalary",d."createdAt",NULL::text "routeName"
        FROM drivers d JOIN vehicles v ON v.id=d."vehicleId" WHERE EXISTS (SELECT 1 FROM subscriptions s
        JOIN routes r ON r.id=s."routeId" WHERE r."vehicleId"=d."vehicleId" AND s."guardianId"=$1 AND s.status='ACTIVE' AND r.active=1)`,user.id),
      this.db.all(`SELECT a.* FROM attendance a WHERE $1::boolean OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.id=a."studentId" AND s."guardianId"=$2) ORDER BY a.date DESC,a.id`,isAdmin,user.id),
      isAdmin ? this.maintenance() : Promise.resolve([]),
      isAdmin ? this.db.all('SELECT * FROM ledger ORDER BY date DESC,"createdAt" DESC') : Promise.resolve([]),
      this.db.all(`SELECT n.* FROM notices n WHERE $1::boolean OR EXISTS (SELECT 1 FROM notice_recipients x WHERE x."noticeId"=n.id AND x."userId"=$2) ORDER BY n."createdAt" DESC`,isAdmin,user.id),
      this.db.all(`SELECT q.*,u.name "userName",s."studentName" FROM management_requests q JOIN users u ON u.id=q."userId"
        LEFT JOIN subscriptions s ON s.id=q."studentId" WHERE $1::boolean OR q."userId"=$2 ORDER BY q."createdAt" DESC`,isAdmin,user.id),
      this.settings(),
      this.db.all(`SELECT q.* FROM route_schedules q WHERE $1::boolean OR EXISTS (SELECT 1 FROM subscriptions s JOIN routes r ON r.id=s."routeId"
        WHERE s."routeId"=q."routeId" AND s."guardianId"=$2 AND s.status='ACTIVE' AND r.active=1
        AND (q."studentId" IS NULL OR q."studentId"=s.id) AND (q."stopId" IS NULL OR q."stopId"=s."stopId")) ORDER BY q.period,q.position,q.id`,isAdmin,user.id),
    ]);
    return {students,drivers,attendance,maintenance,ledger,notices,requests,settings,schedules};
  }

  students(user: User) {
    return this.db.all<Row>(`SELECT p.*,s.id "subscriptionId",s."guardianId",s."studentName",s."routeId",s."stopId",s."monthlyAmount",s.status,s."startedAt",
      u.name "guardianName",u.phone "guardianPhone",r.name "routeName",t.name "stopName",v.id "vehicleId",v.name "vehicleName",
      CASE WHEN $1::text='ADMIN' OR (s.status='ACTIVE' AND r.active=1) THEN v."driverName" ELSE NULL END "driverName",
      CASE WHEN $1::text='ADMIN' OR (s.status='ACTIVE' AND r.active=1) THEN v."driverPhone" ELSE NULL END "driverPhone"
      FROM students p JOIN subscriptions s ON s.id=p.id JOIN users u ON u.id=s."guardianId" JOIN routes r ON r.id=s."routeId"
      JOIN stops t ON t.id=s."stopId" JOIN vehicles v ON v.id=r."vehicleId" WHERE $1::text='ADMIN' OR s."guardianId"=$2 ORDER BY s."studentName",s.id`,user.role,user.id);
  }

  async saveStudent(actor: User, input: CreateStudentDto | UpdateStudentDto, id?: string) {
    const existingId=id;
    id ??=randomUUID();
    return this.write(async () => {
      const existing = existingId ? await this.require('subscriptions',existingId) : undefined;
      const guardianPhone = input.guardianPhone?.replace(/^(?:\+?88)/,'');
      const guardian = guardianPhone ? await this.db.get<Row>(`SELECT id FROM users WHERE phone=$1 AND role='GUARDIAN'`,guardianPhone) : existing ? {id:existing.guardianId} : undefined;
      if (!guardian) throw new BadRequestException('Guardian must register an account with this phone before enrollment');
      if (existing && guardian.id !== existing.guardianId) throw new BadRequestException('Guardian ownership cannot be changed; submit a new enrollment');
      const routeId = input.routeId ?? existing?.routeId;
      const stopId = input.stopId ?? existing?.stopId;
      const route = await this.coverage(routeId,stopId);
      const studentName = input.studentName ?? existing?.studentName;
      const status = input.status ?? existing?.status ?? 'ACTIVE';
      if(existing?.status==='STOPPED' && status==='ACTIVE') throw new BadRequestException('Create a new enrollment to restart service; the stopped billing period must remain intact');
      const amount = input.monthlyAmount ?? (existing && routeId === existing.routeId ? existing.monthlyAmount : route.monthlyAmount);
      if(existing && amount!==existing.monthlyAmount) {
        if(existing.status==='STOPPED') throw new BadRequestException('The fare for a stopped billing period cannot be changed');
        const unbilled=await this.db.get<{month:string}>(`SELECT to_char(m,'YYYY-MM') AS "month" FROM generate_series(
          date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Dhaka'),
          date_trunc('month',now() AT TIME ZONE 'Asia/Dhaka') - interval '1 month',interval '1 month') m
          WHERE NOT EXISTS(SELECT 1 FROM bills b WHERE b."subscriptionId"=$2 AND b.month=to_char(m,'YYYY-MM')) ORDER BY m LIMIT 1`,existing.startedAt,id);
        if(unbilled) throw new ConflictException(`Generate ${unbilled.month} bills before changing this fare so historical charges retain their original amount`);
      }
      const timestamp = now();
      if (!existingId) {
        const requestId = randomUUID();
        await this.db.run(`INSERT INTO service_requests(id,"guardianId","studentName","routeId","stopId",status,"createdAt","reviewedAt","reviewedBy")
          VALUES($1,$2,$3,$4,$5,'APPROVED',$6,$6,$7)`,requestId,guardian.id,studentName,routeId,stopId,timestamp,actor.id);
        await this.db.run(`INSERT INTO subscriptions(id,"guardianId","requestId","studentName","routeId","stopId","monthlyAmount",status,"startedAt","stoppedAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,id,guardian.id,requestId,studentName,routeId,stopId,amount,status,timestamp,status==='STOPPED'?timestamp:null);
        await this.db.run('UPDATE users SET verified=1 WHERE id=$1',guardian.id);
      } else {
        await this.db.run(`UPDATE subscriptions SET "studentName"=$1,"routeId"=$2,"stopId"=$3,"monthlyAmount"=$4,status=$5,"stoppedAt"=$6 WHERE id=$7`,
          studentName,routeId,stopId,amount,status,status==='STOPPED'?(existing?.stoppedAt??timestamp):null,id);
      }
      const old = await this.require('students',id);
      await this.db.run(`UPDATE students SET ${profileFields.map((f,i)=>`"${f}"=$${i+1}`).join(',')} WHERE id=$8`,...profileFields.map(f=>input[f]??old[f]??''),id);
      if(!existingId) await this.db.run(`UPDATE service_requests SET ${profileFields.map((f,i)=>`"${f}"=$${i+1}`).join(',')} WHERE id=(SELECT "requestId" FROM subscriptions WHERE id=$8)`,...profileFields.map(f=>input[f]??''),id);
      await this.notifications.audit(actor.id,existing?'STUDENT_UPDATED':'STUDENT_CREATED',id);
      return (await this.students(actor)).find(s=>s.id===id);
    });
  }

  drivers() {
    return this.db.all<Row>(`SELECT d.*,v.name "vehicleName",(SELECT string_agg(r.name,', ' ORDER BY r.name) FROM routes r WHERE r."vehicleId"=d."vehicleId" AND r.active=1) "routeName"
      FROM drivers d LEFT JOIN vehicles v ON v.id=d."vehicleId" ORDER BY d.name,d.id`);
  }
  async saveDriver(actor: User,input:CreateDriverDto|UpdateDriverDto,id?:string) {
    const existingId=id;
    id ??=randomUUID();
    return this.write(async()=>{
      const existing = existingId ? await this.require('drivers',existingId) : undefined;
      const value = {...{nid:'',address:'',joiningDate:'',monthlySalary:0,status:'ACTIVE',vehicleId:null},...existing,...input};
      if(value.vehicleId) await this.require('vehicles',value.vehicleId);
      if(existing?.vehicleId && existing.vehicleId!==value.vehicleId)
        await this.db.run('UPDATE vehicles SET "driverName"=NULL,"driverPhone"=NULL,"updatedAt"=$1 WHERE id=$2',now(),existing.vehicleId);
      await this.db.run(`INSERT INTO drivers(id,name,phone,nid,address,"joiningDate","monthlySalary",status,"vehicleId","createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,nid=EXCLUDED.nid,address=EXCLUDED.address,
        "joiningDate"=EXCLUDED."joiningDate","monthlySalary"=EXCLUDED."monthlySalary",status=EXCLUDED.status,"vehicleId"=EXCLUDED."vehicleId"`,
        id,value.name,value.phone,value.nid,value.address,value.joiningDate,value.monthlySalary,value.status,value.vehicleId,existing?.createdAt??now());
      if(value.vehicleId) await this.db.run('UPDATE vehicles SET "driverName"=$1,"driverPhone"=$2,"updatedAt"=$3 WHERE id=$4',value.name,value.phone,now(),value.vehicleId);
      await this.notifications.audit(actor.id,existing?'DRIVER_UPDATED':'DRIVER_CREATED',id);
      return (await this.drivers()).find(d=>d.id===id);
    });
  }

  async attendance(actor:User,input:AttendanceBatchDto) {
    return this.write(async()=>{
      const seen = new Set<string>();
      for(const entry of input.entries) {
        if(Boolean(entry.studentId)===Boolean(entry.driverId)) throw new BadRequestException('Provide exactly one studentId or driverId');
        const key=`${entry.studentId??entry.driverId}:${entry.date}`;
        if(seen.has(key)) throw new BadRequestException('Duplicate attendance entry');
        seen.add(key);
        const field=entry.studentId?'studentId':'driverId';
        const personId=entry.studentId??entry.driverId!;
        await this.require(entry.studentId?'students':'drivers',personId);
        await this.db.run(`INSERT INTO attendance(id,"${field}",date,status,note,"updatedAt","recordedBy") VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT("${field}",date) WHERE "${field}" IS NOT NULL DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,"updatedAt"=EXCLUDED."updatedAt","recordedBy"=EXCLUDED."recordedBy"`,
          randomUUID(),personId,entry.date,entry.status,entry.note??'',now(),actor.id);
      }
      await this.notifications.audit(actor.id,'ATTENDANCE_SAVED',actor.id,`${input.entries.length} records`);
      return {saved:input.entries.length};
    });
  }

  maintenance() { return this.db.all<Row>(`SELECT m.*,v.name "vehicleName" FROM maintenance m JOIN vehicles v ON v.id=m."vehicleId" ORDER BY m."serviceDate" DESC,m.id`); }
  async saveMaintenance(actor:User,input:CreateMaintenanceDto|UpdateMaintenanceDto,id?:string) {
    const existingId=id;
    id ??=randomUUID();
    return this.write(async()=>{
      const existing=existingId?await this.require('maintenance',existingId):undefined;
      const value:Row={description:'',nextServiceDate:null,status:'PLANNED',...existing,...input};
      if(value.nextServiceDate && value.nextServiceDate<value.serviceDate) throw new BadRequestException('Next service must not precede service date');
      await this.require('vehicles',value.vehicleId);
      await this.db.run(`INSERT INTO maintenance(id,"vehicleId",title,description,"serviceDate","nextServiceDate",amount,status,"createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET "vehicleId"=EXCLUDED."vehicleId",title=EXCLUDED.title,description=EXCLUDED.description,
        "serviceDate"=EXCLUDED."serviceDate","nextServiceDate"=EXCLUDED."nextServiceDate",amount=EXCLUDED.amount,status=EXCLUDED.status`,
        id,value.vehicleId,value.title,value.description,value.serviceDate,value.nextServiceDate,value.amount,value.status,existing?.createdAt??now());
      // Only completed service costs are actual expenses. Updating keeps one linked entry.
      if(value.status==='COMPLETED' && value.amount>0) {
        await this.db.run(`INSERT INTO ledger(id,type,category,title,amount,date,note,"vehicleId","maintenanceId","createdBy","createdAt")
          VALUES($1,'EXPENSE','MAINTENANCE',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT("maintenanceId") DO UPDATE SET title=EXCLUDED.title,amount=EXCLUDED.amount,date=EXCLUDED.date,note=EXCLUDED.note,"vehicleId"=EXCLUDED."vehicleId"`,
          randomUUID(),value.title,value.amount,value.serviceDate,value.description,value.vehicleId,id,actor.id,now());
      } else await this.db.run('DELETE FROM ledger WHERE "maintenanceId"=$1',id);
      const vehicleIds=new Set<string>([value.vehicleId,...(existing?[existing.vehicleId]:[])]);
      for(const vehicleId of vehicleIds) await this.db.run(`UPDATE vehicles SET status=CASE WHEN EXISTS(SELECT 1 FROM maintenance WHERE "vehicleId"=$1 AND status='IN_PROGRESS') THEN 'MAINTENANCE'
        WHEN status='MAINTENANCE' THEN 'RUNNING' ELSE status END,"updatedAt"=$2 WHERE id=$1`,vehicleId,now());
      await this.notifications.audit(actor.id,existing?'MAINTENANCE_UPDATED':'MAINTENANCE_CREATED',id);
      return (await this.maintenance()).find(m=>m.id===id);
    });
  }

  async ledger(actor:User,input:CreateLedgerDto) {
    return this.write(async()=>{
      if(input.category==='SALARY' && (input.type!=='EXPENSE' || !input.driverId)) throw new BadRequestException('Salary expenses require a driver');
      if(input.vehicleId) await this.require('vehicles',input.vehicleId);
      if(input.driverId) await this.require('drivers',input.driverId);
      const id=randomUUID();
      await this.db.run(`INSERT INTO ledger(id,type,category,title,amount,date,note,"vehicleId","driverId","createdBy","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        id,input.type,input.category,input.title,input.amount,input.date,input.note??'',input.vehicleId??null,input.driverId??null,actor.id,now());
      await this.notifications.audit(actor.id,'LEDGER_CREATED',id);
      return this.require('ledger',id);
    });
  }

  async notice(actor:User,input:CreateNoticeDto) {
    return this.write(async()=>{
      if(input.audience!=='ALL' && !input.targetId) throw new BadRequestException('A target is required for this notice');
      if(input.audience==='ALL' && input.targetId) throw new BadRequestException('An all-guardian notice must not have a target');
      if(input.audience!=='ALL') await this.require(({ROUTE:'routes',VEHICLE:'vehicles',STUDENT:'students'} as const)[input.audience],input.targetId!);
      const recipients=await this.db.all<{id:string}>(`SELECT DISTINCT u.id FROM users u WHERE u.role='GUARDIAN' AND ($1::text='ALL' OR EXISTS(
        SELECT 1 FROM subscriptions s JOIN routes r ON r.id=s."routeId" WHERE s."guardianId"=u.id AND s.status='ACTIVE' AND
        (($1='STUDENT' AND s.id=$2) OR ($1='ROUTE' AND s."routeId"=$2) OR ($1='VEHICLE' AND r."vehicleId"=$2))))`,input.audience,input.targetId??null);
      const id=randomUUID();
      await this.db.run('INSERT INTO notices(id,title,body,category,audience,"targetId","createdBy","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8)',id,input.title,input.body,input.category,input.audience,input.targetId??null,actor.id,now());
      for(const recipient of recipients) {
        await this.db.run('INSERT INTO notice_recipients("noticeId","userId") VALUES($1,$2)',id,recipient.id);
        await this.notifications.create(recipient.id,input.title,input.body,id);
      }
      await this.notifications.audit(actor.id,'NOTICE_SENT',id,`${recipients.length} in-app recipients`);
      return {...await this.require('notices',id),recipientCount:recipients.length};
    });
  }

  async request(user:User,input:CreateManagementRequestDto) {
    return this.write(async()=>{
      if(input.studentId) {
        const student=await this.require('subscriptions',input.studentId);
        if(user.role!=='ADMIN' && (student.guardianId!==user.id || student.status!=='ACTIVE')) throw new ForbiddenException('This student is not assigned to you');
      }
      if(user.role!=='ADMIN' && (input.driverId || input.vehicleId)) throw new ForbiddenException('Guardians submit requests for their own students');
      if(user.role!=='ADMIN' && !input.studentId) throw new BadRequestException('Select your student');
      if(input.driverId) await this.require('drivers',input.driverId);
      if(input.vehicleId) await this.require('vehicles',input.vehicleId);
      if(['ABSENCE','LEAVE'].includes(input.category) && !input.date) throw new BadRequestException('A date is required for absence or leave');
      if(input.category==='ABSENCE' && !input.studentId) throw new BadRequestException('Absence requires a student');
      if(input.category==='LEAVE' && !input.studentId && !input.driverId) throw new BadRequestException('Leave requires a student or driver');
      if(['ABSENCE','LEAVE'].includes(input.category) && input.studentId && input.driverId) throw new BadRequestException('Select one person for absence or leave');
      const id=randomUUID();
      await this.db.run(`INSERT INTO management_requests(id,"userId","studentId","driverId","vehicleId",category,title,description,date,"createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        id,user.id,input.studentId??null,input.driverId??null,input.vehicleId??null,input.category,input.title,input.description,input.date??null,now());
      await this.notifications.admins('নতুন রিকোয়েস্ট',input.title,id);
      await this.notifications.audit(user.id,'MANAGEMENT_REQUEST_CREATED',id);
      return this.require('management_requests',id);
    });
  }
  async decision(actor:User,id:string,input:DecisionDto) {
    return this.write(async()=>{
      if(input.decision==='REJECTED' && !input.note?.trim()) throw new BadRequestException('Please explain the rejection');
      const request=await this.require('management_requests',id);
      if(request.status!=='PENDING') throw new ConflictException('This request has already been reviewed');
      await this.db.run('UPDATE management_requests SET status=$1,note=$2,"reviewedAt"=$3,"reviewedBy"=$4 WHERE id=$5',input.decision,input.note??'',now(),actor.id,id);
      if(input.decision==='APPROVED' && ['ABSENCE','LEAVE'].includes(request.category) && request.date) {
        await this.attendance(actor,{entries:[{studentId:request.studentId??undefined,driverId:request.driverId??undefined,date:request.date,status:request.category==='ABSENCE'?'ABSENT':'LEAVE',note:request.description}]});
      }
      await this.notifications.create(request.userId,input.decision==='APPROVED'?'রিকোয়েস্ট অনুমোদিত':'রিকোয়েস্ট প্রত্যাখ্যাত',input.note||request.title,id);
      await this.notifications.audit(actor.id,`MANAGEMENT_REQUEST_${input.decision}`,id,input.note);
      return this.require('management_requests',id);
    });
  }

  async settings() { return (await this.db.get<{data:Row}>('SELECT data FROM business_settings WHERE id=1'))!.data; }
  async updateSettings(actor:User,input:SettingsDto) {
    return this.write(async()=>{
      if(Object.values(input).some(value=>value===null)) throw new BadRequestException('Settings values must be strings');
      await this.db.run('UPDATE business_settings SET data=data || $1::jsonb WHERE id=1',JSON.stringify(input));
      await this.notifications.audit(actor.id,'SETTINGS_UPDATED',actor.id);
      return this.settings();
    });
  }
  async schedule(actor:User,routeId:string,input:ScheduleDto) {
    return this.write(async()=>{
      await this.require('routes',routeId);
      const positions=new Set<string>();
      for(const entry of input.entries) {
        if(positions.has(`${entry.period}:${entry.position}`)) throw new BadRequestException('Schedule positions must be unique within each period');
        positions.add(`${entry.period}:${entry.position}`);
        if(entry.stopId && (await this.require('stops',entry.stopId)).routeId!==routeId) throw new BadRequestException('Stop belongs to another route');
        if(entry.studentId) {
          const student=await this.require('subscriptions',entry.studentId);
          if(student.routeId!==routeId || student.status!=='ACTIVE' || (entry.stopId && student.stopId!==entry.stopId)) throw new BadRequestException('Student is not assigned to this route and stop');
        }
      }
      await this.db.run('DELETE FROM route_schedules WHERE "routeId"=$1',routeId);
      for(const entry of input.entries) await this.db.run('INSERT INTO route_schedules(id,"routeId","stopId","studentId",label,time,period,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',randomUUID(),routeId,entry.stopId??null,entry.studentId??null,entry.label,entry.time,entry.period,entry.position);
      await this.notifications.audit(actor.id,'ROUTE_SCHEDULE_UPDATED',routeId);
      return this.db.all('SELECT * FROM route_schedules WHERE "routeId"=$1 ORDER BY period,position',routeId);
    });
  }

  async report(month:string) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('Month must be YYYY-MM');
    return this.db.transaction(async()=>{
    const billing=await this.db.get<Row>(`SELECT COALESCE(sum(amount) FILTER(WHERE month=$1),0)::float8 expected,
        COALESCE(sum(amount) FILTER(WHERE month=$1 AND status='PAID'),0)::float8 paid,
        COALESCE(sum(amount) FILTER(WHERE month=$1 AND status='UNPAID'),0)::float8 due,
        COALESCE(sum(amount) FILTER(WHERE month<$1 AND status='UNPAID'),0)::float8 "previousDue" FROM bills`,month);
    const ledger=await this.db.all<Row>('SELECT * FROM ledger WHERE left(date,7)=$1 ORDER BY date DESC,"createdAt" DESC',month);
    const students=await this.db.get<Row>(`SELECT count(*)::int total,count(*) FILTER(WHERE status='ACTIVE')::int active FROM subscriptions`);
    const drivers=await this.db.get<{count:number}>('SELECT count(*)::int count FROM drivers');
    const vehicles=await this.db.get<{count:number}>('SELECT count(*)::int count FROM vehicles');
    const attendance=await this.db.get<Row>(`SELECT count(*) FILTER(WHERE status='PRESENT')::int present,count(*) FILTER(WHERE status='ABSENT')::int absent,count(*) FILTER(WHERE status='LEAVE')::int leave FROM attendance WHERE left(date,7)=$1`,month);
    const fare=await this.db.get<{amount:number}>(`SELECT COALESCE(sum(amount),0)::float8 amount FROM bills WHERE status='PAID' AND to_char("paidAt"::timestamptz AT TIME ZONE 'Asia/Dhaka','YYYY-MM')=$1`,month);
    const sum=(type:string)=>ledger.filter(x=>x.type===type).reduce((a,b)=>a+b.amount,0);
    const cashflow={fareReceived:fare!.amount,otherIncome:sum('INCOME'),expenses:sum('EXPENSE'),investment:sum('INVESTMENT'),net:fare!.amount+sum('INCOME')-sum('EXPENSE')};
    return {month,billing,cashflow,students,drivers:drivers!.count,vehicles:vehicles!.count,attendance,ledger};
    });
  }

  private async coverage(routeId:string,stopId:string) {
    const route=await this.db.get<Row>('SELECT r.* FROM routes r JOIN stops s ON s."routeId"=r.id WHERE r.id=$1 AND s.id=$2 AND r.active=1',routeId,stopId);
    if(!route) throw new BadRequestException('Select a stop on an active route');
    return route;
  }
  private async require(table:string,id:string):Promise<Row> {
    // Table identifiers only come from hard-coded service calls; values remain parameterized.
    const row=await this.db.get<Row>(`SELECT * FROM ${table} WHERE id=$1`,id);
    if(!row) throw new NotFoundException(`${table.replace(/_/g,' ')} record not found`);
    return row;
  }
  private async write<T>(work:()=>Promise<T>):Promise<T> {
    try{return await this.db.transaction(work);}catch(error){
      const code=(error as {code?:string}).code;
      if(code==='23505') throw new ConflictException('This record or assignment already exists');
      if(code==='23503') throw new BadRequestException('A referenced record does not exist');
      if(code==='23514' || code==='23502') throw new BadRequestException('Invalid record values');
      throw error;
    }
  }
}
