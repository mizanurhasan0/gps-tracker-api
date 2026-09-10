export interface Vehicle {
  id: string;
  name: string;
  plate: string;
  imei: string;
  driverName?: string;
  driverPhone?: string;
  model?: string;
  purchaseDate?: string;
  fitnessExpiresAt?: string;
  licenseExpiresAt?: string;
  status?: 'RUNNING' | 'MAINTENANCE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}
