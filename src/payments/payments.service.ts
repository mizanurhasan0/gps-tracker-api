import { dhakaMonth } from '../common/dhaka-time';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DecisionDto,
  PaymentAccountDto,
  PaymentEvidenceDto,
  PaymentSubmissionDto,
} from './payments.dto';
export interface Bill {
  id: string;
  guardianId: string;
  subscriptionId: string;
  month: string;
  amount: number;
  status: 'UNPAID' | 'PAID' | 'WAIVED';
  createdAt: string;
  paidAt: string | null;
}
export interface PaymentSubmission extends PaymentSubmissionDto {
  id: string;
  guardianId: string;
  methodName: string;
  transactionId: string;
  recipientNumber: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  note: string;
  createdAt: string;
  reviewedAt: string | null;
}
export interface PaymentAccount {
  method: string;
  name: string;
  imageUrl: string;
  number: string;
  instructions: string;
}
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  async accounts(): Promise<PaymentAccount[]> {
    return await this.db.all('SELECT * FROM payment_accounts ORDER BY name, method');
  }

  async setAccount(actor: User, method: string, input: PaymentAccountDto): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(method))
      throw new BadRequestException('Invalid payment method');
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO payment_accounts (method,number,instructions,name,"imageUrl") VALUES ($1,$2,$3,$4,$5) ON CONFLICT(method)
        DO UPDATE SET number = excluded.number, instructions = excluded.instructions,
          name = COALESCE($7, payment_accounts.name), "imageUrl" = COALESCE($6, payment_accounts."imageUrl")`,
        method,
        input.number,
        input.instructions,
        input.name ?? (method === 'BKASH' ? 'bKash' : method === 'ROCKET' ? 'Rocket' : method),
        input.imageUrl ?? '',
        input.imageUrl ?? null,
        input.name ?? null,
      );
      await this.db.run(
        `INSERT INTO payment_account_history (method,number) VALUES ($1,$2) ON CONFLICT(method,number) DO NOTHING`,
        method,
        input.number,
      );
      await this.notifications.audit(actor.id, 'PAYMENT_ACCOUNT_UPDATED', method, input.number);
    });
  }

  async listBills(user: User, month?: string) {
    return await this.db.all<
      Bill & {
        studentName: string;
        guardianName: string;
        pendingSubmissionId: string | null;
      }
    >(
      `SELECT b.*, s."studentName",s."studentId",s."shiftId", u.name "guardianName",
      (SELECT p.id FROM payment_submissions p WHERE p."billId" = b.id AND p.status = 'PENDING') "pendingSubmissionId"
      FROM bills b JOIN subscriptions s ON s.id = b."subscriptionId" JOIN users u ON u.id = b."guardianId"
      WHERE ($1::text = 'ADMIN' OR b."guardianId" = $2) AND ($3::text IS NULL OR b.month = $4) ORDER BY b.month DESC, b."createdAt" DESC`,
      user.role,
      user.id,
      month ?? null,
      month ?? null,
    );
  }

  async listSubmissions(user: User) {
    return await this.db.all<
      PaymentSubmission & {
        guardianName: string;
        guardianPhone: string;
        month: string;
        studentName: string;
      }
    >(
      `SELECT p.*,u.name "guardianName",u.phone "guardianPhone",b.month,s."studentName",s."studentId",s."shiftId"
      FROM payment_submissions p JOIN users u ON u.id = p."guardianId" JOIN bills b ON b.id = p."billId"
      JOIN subscriptions s ON s.id = b."subscriptionId"
      WHERE ($1::text = 'ADMIN' OR p."guardianId" = $2) ORDER BY p."createdAt" DESC`,
      user.role,
      user.id,
    );
  }

  async generateBills(actor: User, month: string): Promise<{ created: number }> {
    if (month > dhakaMonth()) throw new BadRequestException('Future bills cannot be generated');
    return this.db.transaction(async () => {
      const subscriptions = await this.db.all<{
        id: string;
        guardianId: string;
        monthlyAmount: number;
        studentName: string;
        stoppedOn: string | null;
        finalMonthlyFee: number | null;
      }>(
        `SELECT * FROM subscriptions
        WHERE to_char("startedAt"::timestamptz AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') <= $1
        AND ("stoppedAt" IS NULL OR to_char("stoppedAt"::timestamptz AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') >= $2)
        FOR UPDATE`,
        month,
        month,
      );
      let created = 0;
      for (const subscription of subscriptions) {
        const amount =
          subscription.stoppedOn?.slice(0, 7) === month &&
          subscription.finalMonthlyFee != null
            ? subscription.finalMonthlyFee
            : subscription.monthlyAmount;
        if (amount === 0) continue;
        const id = randomUUID();
        const result = await this.db.run(
          `INSERT INTO bills (id,"guardianId","subscriptionId",month,amount,status,"createdAt")
          VALUES ($1,$2,$3,$4,$5,'UNPAID',$6) ON CONFLICT("subscriptionId",month) DO NOTHING`,
          id,
          subscription.guardianId,
          subscription.id,
          month,
          amount,
          new Date().toISOString(),
        );
        if (result.rowCount) {
          created++;
          await this.notifications.create(
            subscription.guardianId,
            'Monthly bill ready',
            `${subscription.studentName}: your ${month} transport bill is ready.`,
            id,
          );
        }
      }
      await this.notifications.audit(actor.id, 'BILLS_GENERATED', month, `${created} bills`);
      return { created };
    });
  }

  async submit(user: User, input: PaymentSubmissionDto): Promise<PaymentSubmission> {
    this.requireProof(input);
    return this.db
      .transaction(async () => {
        const bill = await this.db.get<Bill>(
          `SELECT * FROM bills WHERE id = $1 AND "guardianId" = $2`,
          input.billId,
          user.id,
        );
        if (!bill) throw new NotFoundException('Bill not found');
        if (bill.status === 'PAID') throw new ConflictException('This bill is already paid');
        if (bill.status === 'WAIVED') throw new ConflictException('This bill has been waived');
        if (bill.amount !== input.amount)
          throw new BadRequestException(
            'Send the full bill amount. Partial payments are not supported yet',
          );
        const account = await this.db.get<PaymentAccount>(
          `SELECT * FROM payment_accounts WHERE method = $1`,
          input.method,
        );
        if (!account)
          throw new BadRequestException('This payment method is not configured. Contact the admin');
        if (
          !(await this.db.get(
            `SELECT number FROM payment_account_history WHERE method = $1 AND number = $2`,
            input.method,
            input.recipientNumber,
          ))
        ) {
          throw new BadRequestException(
            'This receiving number is not an admin payment account. Contact the admin before sending money',
          );
        }
        if (
          await this.db.get(
            `SELECT id FROM payment_submissions WHERE "billId" = $1 AND status = 'PENDING'`,
            bill.id,
          )
        ) {
          throw new ConflictException('This bill already has a submission awaiting review');
        }
        if (
          input.transactionId &&
          (await this.db.get(
            `SELECT id FROM payment_submissions WHERE method = $1 AND lower("transactionId") = lower($2) AND status != 'REJECTED'`,
            input.method,
            input.transactionId,
          ))
        ) {
          throw new ConflictException('This transaction ID has already been submitted');
        }
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO payment_submissions
        (id,"billId","guardianId",method,"recipientNumber","senderNumber","transactionId",amount,status,"createdAt","methodName","evidenceImageUrl","transactionInfo")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12)`,
          id,
          bill.id,
          user.id,
          input.method,
          input.recipientNumber,
          input.senderNumber,
          input.transactionId ?? '',
          input.amount,
          new Date().toISOString(),
          account.name,
          input.evidenceImageUrl ?? '',
          input.transactionInfo ?? '',
        );
        await this.notifications.admins(
          'Payment needs verification',
          `${user.name} submitted a ${account.name} payment for ${bill.month}.`,
          id,
        );
        await this.notifications.audit(user.id, 'PAYMENT_SUBMITTED', id);
        return (await this.db.get<PaymentSubmission>(
          `SELECT * FROM payment_submissions WHERE id = $1`,
          id,
        ))!;
      })
      .catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          const constraint = 'constraint' in error ? String(error.constraint) : '';
          if (constraint === 'pending_payment')
            throw new ConflictException('This bill already has a submission awaiting review');
          if (constraint === 'reserved_transaction')
            throw new ConflictException('This transaction ID has already been submitted');
        }
        throw error;
      });
  }

  private requireProof(input: PaymentEvidenceDto) {
    if (!input.transactionId?.trim() && !input.evidenceImageUrl)
      throw new BadRequestException('Enter a transaction ID or upload payment evidence.');
  }

  async updateEvidence(user: User, id: string, input: PaymentEvidenceDto) {
    return this.db.transaction(async () => {
      const payment = await this.db.get<PaymentSubmission>(
        `SELECT * FROM payment_submissions WHERE id=$1 AND "guardianId"=$2 FOR UPDATE`,
        id,
        user.id,
      );
      if (!payment) throw new NotFoundException('Payment submission not found');
      if (payment.status !== 'PENDING')
        throw new ConflictException('This payment has already been reviewed');
      const next = { ...payment, ...input };
      this.requireProof(next);
      try {
        await this.db.run(
          `UPDATE payment_submissions SET "transactionId"=$1,"evidenceImageUrl"=$2,"transactionInfo"=$3 WHERE id=$4`,
          next.transactionId ?? '',
          next.evidenceImageUrl ?? '',
          next.transactionInfo ?? '',
          id,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('This transaction ID has already been submitted');
        throw error;
      }
      await this.notifications.audit(user.id, 'PAYMENT_EVIDENCE_UPDATED', id);
      return this.db.get<PaymentSubmission>('SELECT * FROM payment_submissions WHERE id=$1', id);
    });
  }

  async review(actor: User, id: string, input: DecisionDto): Promise<PaymentSubmission> {
    if (input.decision === 'REJECTED' && !input.note?.trim())
      throw new BadRequestException('Please explain why this payment was rejected');
    return this.db.transaction(async () => {
      const submission = await this.db.get<PaymentSubmission>(
        `SELECT * FROM payment_submissions WHERE id = $1 FOR UPDATE`,
        id,
      );
      if (!submission) throw new NotFoundException('Payment submission not found');
      if (submission.status !== 'PENDING')
        throw new ConflictException('This payment has already been reviewed');
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED') {
        const result = await this.db.run(
          `UPDATE bills SET status = 'PAID', "paidAt" = $1 WHERE id = $2 AND status = 'UNPAID'`,
          now,
          submission.billId,
        );
        if (!result.rowCount) throw new ConflictException('This bill is already paid');
      }
      await this.db.run(
        `UPDATE payment_submissions SET status = $1, note = $2, "reviewedBy" = $3, "reviewedAt" = $4 WHERE id = $5`,
        input.decision,
        input.note ?? '',
        actor.id,
        now,
        id,
      );
      await this.notifications.create(
        submission.guardianId,
        input.decision === 'APPROVED' ? 'Payment completed' : 'Payment needs correction',
        input.decision === 'APPROVED'
          ? 'The admin verified your payment. Your monthly bill is now paid.'
          : `Admin note: ${input.note}. You can submit corrected details.`,
        id,
      );
      await this.notifications.audit(actor.id, `PAYMENT_${input.decision}`, id, input.note);
      return (await this.db.get<PaymentSubmission>(
        `SELECT * FROM payment_submissions WHERE id = $1`,
        id,
      ))!;
    });
  }
}
