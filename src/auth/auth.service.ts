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
import { LoginDto, RegisterDto } from './auth.dto';
import { User } from './auth.types';
const scrypt = promisify(scryptCallback);
const publicColumns = 'id,name,phone,role,verified,createdAt';

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
        'Set ADMIN_PHONE to a Bangladesh mobile number and ADMIN_PASSWORD to at least 12 characters',
      );
    }
    if (this.db.get("SELECT id FROM users WHERE role = 'ADMIN'")) return;
    const hash = await this.hashPassword(password);
    if (this.db.get('SELECT id FROM users WHERE phone = ?', phone)) {
      throw new Error(
        'ADMIN_PHONE already belongs to an account; use an unused number for bootstrap',
      );
    }
    this.db.run(
      `INSERT INTO users (id,name,phone,passwordHash,role,verified,createdAt) VALUES (?,?,?,?, 'ADMIN',1,?)`,
      randomUUID(),
      'Transport Admin',
      phone,
      hash,
      new Date().toISOString(),
    );
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
        429,
      );
  }

  async register(input: RegisterDto) {
    const passwordHash = await this.hashPassword(input.password);
    if (this.db.get('SELECT id FROM users WHERE phone = ?', input.phone))
      throw new ConflictException('This phone number is already registered');
    const id = randomUUID();
    this.db.run(
      `INSERT INTO users (id,name,phone,passwordHash,role,createdAt) VALUES (?,?,?,?, 'GUARDIAN',?)`,
      id,
      input.name,
      input.phone,
      passwordHash,
      new Date().toISOString(),
    );
    return this.issueSession(id);
  }

  async login(input: LoginDto) {
    const account = this.db.get<User & { passwordHash: string }>(
      'SELECT * FROM users WHERE phone = ?',
      input.phone,
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

  authenticate(token: string | undefined): User {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Please sign in');
    const user = this.db.get<User>(
      `SELECT u.${publicColumns.split(',').join(',u.')} FROM users u
      JOIN sessions s ON s.userId = u.id WHERE s.tokenHash = ? AND s.expiresAt > ?`,
      this.digest(token),
      new Date().toISOString(),
    );
    if (!user)
      throw new UnauthorizedException(
        'Your session expired. Please sign in again',
      );
    return user;
  }

  logout(token: string): void {
    this.db.run('DELETE FROM sessions WHERE tokenHash = ?', this.digest(token));
  }

  private issueSession(id: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM sessions WHERE expiresAt <= ?',
        new Date().toISOString(),
      );
      this.db.run(
        'INSERT INTO sessions VALUES (?,?,?)',
        this.digest(token),
        id,
        expiresAt,
      );
    });
    return {
      token,
      expiresAt,
      user: this.db.get<User>(
        `SELECT ${publicColumns} FROM users WHERE id = ?`,
        id,
      )!,
    };
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt}:${derived.toString('hex')}`;
  }
}
