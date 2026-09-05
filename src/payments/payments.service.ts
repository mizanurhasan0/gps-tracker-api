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
  PaymentSubmissionDto,
} from './payments.dto';
export interface Bill {
  id: string;
  guardianId: string;
  subscriptionId: string;
  month: string;
  amount: number;
  status: 'UNPAID' | 'PAID';
  createdAt: string;
  paidAt: string | null;
}
export interface PaymentSubmission extends PaymentSubmissionDto {
  id: string;
  guardianId: string;
  recipientNumber: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  note: string;
  createdAt: string;
  reviewedAt: string | null;
}
export interface PaymentAccount {
  method: 'BKASH' | 'ROCKET';
  number: string;
  instructions: string;
}
/** Bangladesh billing month, independent of the server's local timezone. */
export function billingMonth(date = new Date()): string {
  return new Date(date.getTime() + 6 * 60 * 60_000).toISOString().slice(0, 7);
}
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  accounts(): PaymentAccount[] {
    return this.db.all('SELECT * FROM payment_accounts ORDER BY method');
  }

  setAccount(actor: User, method: string, input: PaymentAccountDto): void {
    if (!['BKASH', 'ROCKET'].includes(method))
      throw new BadRequestException('Unsupported payment method');
    if (method === 'BKASH' && input.number.length !== 11)
      throw new BadRequestException('bKash number must have 11 digits');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO payment_accounts VALUES (?,?,?) ON CONFLICT(method)
        DO UPDATE SET number = excluded.number, instructions = excluded.instructions`,
        method,
        input.number,
        input.instructions,
      );
      this.db.run(
        'INSERT OR IGNORE INTO payment_account_history VALUES (?,?)',
        method,
        input.number,
      );
      this.notifications.audit(
        actor.id,
        'PAYMENT_ACCOUNT_UPDATED',
        method,
        input.number,
      );
    });
  }

  listBills(user: User, month?: string) {
    return this.db.all<
      Bill & {
        studentName: string;
        guardianName: string;
        pendingSubmissionId: string | null;
      }
    >(
      `SELECT b.*, s.studentName, u.name guardianName,
      (SELECT p.id FROM payment_submissions p WHERE p.billId = b.id AND p.status = 'PENDING') pendingSubmissionId
      FROM bills b JOIN subscriptions s ON s.id = b.subscriptionId JOIN users u ON u.id = b.guardianId
      WHERE (? = 'ADMIN' OR b.guardianId = ?) AND (? IS NULL OR b.month = ?) ORDER BY b.month DESC, b.createdAt DESC`,
      user.role,
      user.id,
      month ?? null,
      month ?? null,
    );
  }

  listSubmissions(user: User) {
    return this.db.all<
      PaymentSubmission & {
        guardianName: string;
        guardianPhone: string;
        month: string;
        studentName: string;
      }
    >(
      `SELECT p.*,u.name guardianName,u.phone guardianPhone,b.month,s.studentName
      FROM payment_submissions p JOIN users u ON u.id = p.guardianId JOIN bills b ON b.id = p.billId
      JOIN subscriptions s ON s.id = b.subscriptionId
      WHERE (? = 'ADMIN' OR p.guardianId = ?) ORDER BY p.createdAt DESC`,
      user.role,
      user.id,
    );
  }

  generateBills(actor: User, month: string): { created: number } {
    if (month > billingMonth())
      throw new BadRequestException('Future bills cannot be generated');
    return this.db.transaction(() => {
      const subscriptions = this.db.all<{
        id: string;
        guardianId: string;
        monthlyAmount: number;
        studentName: string;
      }>(
        `SELECT * FROM subscriptions
        WHERE substr(datetime(startedAt, '+6 hours'),1,7) <= ?
        AND (stoppedAt IS NULL OR substr(datetime(stoppedAt, '+6 hours'),1,7) >= ?)`,
        month,
        month,
      );
      let created = 0;
      for (const subscription of subscriptions) {
        const id = randomUUID();
        const result = this.db.run(
          `INSERT INTO bills (id,guardianId,subscriptionId,month,amount,status,createdAt)
          VALUES (?,?,?,?,?,'UNPAID',?) ON CONFLICT(subscriptionId,month) DO NOTHING`,
          id,
          subscription.guardianId,
          subscription.id,
          month,
          subscription.monthlyAmount,
          new Date().toISOString(),
        );
        if (result.changes) {
          created++;
          this.notifications.create(
            subscription.guardianId,
            'Monthly bill ready',
            `${subscription.studentName}: your ${month} transport bill is ready.`,
            id,
          );
        }
      }
      this.notifications.audit(
        actor.id,
        'BILLS_GENERATED',
        month,
        `${created} bills`,
      );
      return { created };
    });
  }

  submit(user: User, input: PaymentSubmissionDto): PaymentSubmission {
    return this.db.transaction(() => {
      const bill = this.db.get<Bill>(
        'SELECT * FROM bills WHERE id = ? AND guardianId = ?',
        input.billId,
        user.id,
      );
      if (!bill) throw new NotFoundException('Bill not found');
      if (bill.status === 'PAID')
        throw new ConflictException('This bill is already paid');
      if (bill.amount !== input.amount)
        throw new BadRequestException(
          'Send the full bill amount. Partial payments are not supported yet',
        );
      const account = this.db.get<PaymentAccount>(
        'SELECT * FROM payment_accounts WHERE method = ?',
        input.method,
      );
      if (!account)
        throw new BadRequestException(
          'This payment method is not configured. Contact the admin',
        );
      if (
        !this.db.get(
          'SELECT number FROM payment_account_history WHERE method = ? AND number = ?',
          input.method,
          input.recipientNumber,
        )
      ) {
        throw new BadRequestException(
          'This receiving number is not an admin payment account. Contact the admin before sending money',
        );
      }
      if (input.method === 'BKASH' && input.senderNumber.length !== 11)
        throw new BadRequestException(
          'bKash sender number must have 11 digits',
        );
      if (
        this.db.get(
          "SELECT id FROM payment_submissions WHERE billId = ? AND status = 'PENDING'",
          bill.id,
        )
      ) {
        throw new ConflictException(
          'This bill already has a submission awaiting review',
        );
      }
      if (
        this.db.get(
          "SELECT id FROM payment_submissions WHERE method = ? AND transactionId = ? AND status != 'REJECTED'",
          input.method,
          input.transactionId,
        )
      ) {
        throw new ConflictException(
          'This transaction ID has already been submitted',
        );
      }
      const id = randomUUID();
      this.db.run(
        `INSERT INTO payment_submissions
        (id,billId,guardianId,method,recipientNumber,senderNumber,transactionId,amount,status,createdAt)
        VALUES (?,?,?,?,?,?,?,?,'PENDING',?)`,
        id,
        bill.id,
        user.id,
        input.method,
        input.recipientNumber,
        input.senderNumber,
        input.transactionId,
        input.amount,
        new Date().toISOString(),
      );
      this.notifications.admins(
        'Payment needs verification',
        `${user.name} submitted a ${input.method} payment for ${bill.month}.`,
        id,
      );
      this.notifications.audit(user.id, 'PAYMENT_SUBMITTED', id);
      return this.db.get<PaymentSubmission>(
        'SELECT * FROM payment_submissions WHERE id = ?',
        id,
      )!;
    });
  }

  review(actor: User, id: string, input: DecisionDto): PaymentSubmission {
    if (input.decision === 'REJECTED' && !input.note?.trim())
      throw new BadRequestException(
        'Please explain why this payment was rejected',
      );
    return this.db.transaction(() => {
      const submission = this.db.get<PaymentSubmission>(
        'SELECT * FROM payment_submissions WHERE id = ?',
        id,
      );
      if (!submission)
        throw new NotFoundException('Payment submission not found');
      if (submission.status !== 'PENDING')
        throw new ConflictException('This payment has already been reviewed');
      const now = new Date().toISOString();
      if (input.decision === 'APPROVED') {
        const result = this.db.run(
          "UPDATE bills SET status = 'PAID', paidAt = ? WHERE id = ? AND status = 'UNPAID'",
          now,
          submission.billId,
        );
        if (!result.changes)
          throw new ConflictException('This bill is already paid');
      }
      this.db.run(
        'UPDATE payment_submissions SET status = ?, note = ?, reviewedBy = ?, reviewedAt = ? WHERE id = ?',
        input.decision,
        input.note ?? '',
        actor.id,
        now,
        id,
      );
      this.notifications.create(
        submission.guardianId,
        input.decision === 'APPROVED'
          ? 'Payment completed'
          : 'Payment needs correction',
        input.decision === 'APPROVED'
          ? 'The admin verified your payment. Your monthly bill is now paid.'
          : `Admin note: ${input.note}. You can submit corrected details.`,
        id,
      );
      this.notifications.audit(
        actor.id,
        `PAYMENT_${input.decision}`,
        id,
        input.note,
      );
      return this.db.get<PaymentSubmission>(
        'SELECT * FROM payment_submissions WHERE id = ?',
        id,
      )!;
    });
  }
}
