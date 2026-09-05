export type Role = 'ADMIN' | 'GUARDIAN';
export interface User {
  id: string;
  name: string;
  phone: string;
  role: Role;
  verified: number;
  createdAt: string;
}
export interface AuthRequest {
  headers: { authorization?: string };
  user: User;
  ip?: string;
}
