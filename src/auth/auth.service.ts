import {
  ConflictException,
  HttpException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService } from '../database/database.service';
import { LoginDto, RegisterDto, UpdateProfileDto } from './auth.dto';
import { User } from './auth.types';
import { hashPassword } from './password';
const scrypt = promisify(scryptCallback);
const publicColumns = 'id,name,phone,role,verified,"createdAt"';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const phone = process.env.ADMIN_PHONE;
    const password = process.env.ADMIN_PASSWORD;
    if (!phone && !password) return;
    if (
      !phone ||
      !/^01[3-9]\d{8}$/.test(phone) ||
      !password ||
      password.length < 12
    ) {
      throw new Error(
        'Set ADMIN_PHONE to a Bangladesh mobile number and ADMIN_PASSWORD to at least 12 characters'
      );
    }
    const hash = await hashPassword(password);
    await this.db.transaction(async () => {
      // Serialize concurrent bootstrap attempts, including different admin phones.
      await this.db.run('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      if (await this.db.get("SELECT id FROM users WHERE role = 'ADMIN'"))
        return;
      if (await this.db.get('SELECT id FROM users WHERE phone = $1', phone)) {
        throw new Error(
          'ADMIN_PHONE already belongs to an account; use an unused number for bootstrap'
        );
      }
      await this.db.run(
        `INSERT INTO users (id,name,phone,"passwordHash",role,verified,"createdAt") VALUES ($1,$2,$3,$4,'ADMIN',1,$5)`,
        randomUUID(),
        'Transport Admin',
        phone,
        hash,
        new Date().toISOString()
      );
    });
  }

  throttle(key: string): void {
    const now = Date.now();
    for (const [entry, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(entry);
    const state = this.attempts.get(key) ?? {
      count: 0,
      until: now + 15 * 60_000,
    };
    state.count += 1;
    this.attempts.set(key, state);
    if (state.count > 15)
      throw new HttpException(
        'Too many attempts. Please try again in 15 minutes.',
        429
      );
  }

  async register(input: RegisterDto) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async () => {
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO users (id,name,phone,"passwordHash",role,"createdAt") VALUES ($1,$2,$3,$4,'GUARDIAN',$5)`,
          id,
          input.name,
          input.phone,
          passwordHash,
          new Date().toISOString()
        );
        return this.issueSession(id);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('This phone number is already registered');
      throw error;
    }
  }

  async login(input: LoginDto) {
    const account = await this.db.get<User & { passwordHash: string }>(
      'SELECT * FROM users WHERE phone = $1',
      input.phone
    );
    // Derive a key even for unknown accounts to avoid a cheap user enumeration path.
    const [salt, expected] = (
      account?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`
    ).split(':');
    const actual = (await scrypt(input.password, salt, 64)) as Buffer;
    if (!account || !timingSafeEqual(Buffer.from(expected, 'hex'), actual))
      throw new UnauthorizedException('Phone number or password is incorrect');
    return this.issueSession(account.id);
  }

  async authenticate(token: string | undefined): Promise<User> {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Please sign in');
    const user = await this.db.get<User>(
      `SELECT u.${publicColumns.split(',').join(',u.')} FROM users u
      JOIN sessions s ON s."userId" = u.id WHERE s."tokenHash" = $1 AND s."expiresAt" > $2`,
      this.digest(token),
      new Date().toISOString()
    );
    if (!user)
      throw new UnauthorizedException(
        'Your session expired. Please sign in again'
      );
    return user;
  }

  async updateProfile(id: string, input: UpdateProfileDto): Promise<User> {
    const user = await this.db.get<User>(
      `UPDATE users SET name = $1 WHERE id = $2 RETURNING ${publicColumns}`,
      input.name,
      id
    );
    if (!user) throw new UnauthorizedException('Please sign in again.');
    return user;
  }

  async logout(token: string): Promise<void> {
    await this.db.run(
      'DELETE FROM sessions WHERE "tokenHash" = $1',
      this.digest(token)
    );
  }

  private async issueSession(id: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    await this.db.transaction(async () => {
      await this.db.run(
        'DELETE FROM sessions WHERE "expiresAt" <= $1',
        new Date().toISOString()
      );
      await this.db.run(
        'INSERT INTO sessions ("tokenHash","userId","expiresAt") VALUES ($1,$2,$3)',
        this.digest(token),
        id,
        expiresAt
      );
    });
    return {
      token,
      expiresAt,
      user: (await this.db.get<User>(
        `SELECT ${publicColumns} FROM users WHERE id = $1`,
        id
      ))!,
    };
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
