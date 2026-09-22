import { schema } from './schema';
import { managementSchema } from './management.schema';
import { faresSchema } from './fares.schema';
import { shiftsSchema } from './shifts.schema';
import { bannersSchema } from './banners.schema';
import { bannerLinksSchema } from './banner-links.schema';
import { bannerRoutesSchema } from './banner-routes.schema';
import { telegramSchema } from './telegram.schema';
import { paymentsSchema } from './payments.schema';

/** Append migrations; existing versions must retain their upgrade semantics. */
export const migrations = [
  [1, schema],
  [2, managementSchema],
  [3, faresSchema],
  [4, shiftsSchema],
  [5, bannersSchema],
  [6, bannerLinksSchema],
  [7, bannerRoutesSchema],
  [8, telegramSchema],
  [9, paymentsSchema],
] as const;
