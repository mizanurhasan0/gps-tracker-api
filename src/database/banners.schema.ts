/** Version 5 adds admin-managed dashboard banners. */
export const bannersSchema = `
CREATE TABLE banners (
 id TEXT PRIMARY KEY,
 eyebrow TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL,
 body TEXT NOT NULL DEFAULT '',
 "imageUrl" TEXT NOT NULL DEFAULT '',
 "actionLabel" TEXT NOT NULL DEFAULT '',
 "actionRoute" TEXT NOT NULL DEFAULT '',
 audience TEXT NOT NULL DEFAULT 'ALL' CHECK(audience IN ('ALL','ADMIN','GUARDIAN')),
 theme TEXT NOT NULL DEFAULT 'PINK' CHECK(theme IN ('PINK','BLUE','GREEN','AMBER')),
 "sortOrder" INTEGER NOT NULL DEFAULT 0 CHECK("sortOrder" >= 0 AND "sortOrder" <= 10000),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 "createdBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
 "createdAt" TEXT NOT NULL,
 "updatedAt" TEXT NOT NULL
);
CREATE INDEX banners_visibility_order
 ON banners(active,audience,"sortOrder","createdAt");

INSERT INTO banners
 (id,eyebrow,title,body,"imageUrl","actionLabel","actionRoute",audience,theme,"sortOrder",active,"createdAt","updatedAt")
 VALUES
 ('00000000-0000-4000-8000-000000000001','bKash','Monthly bill ready',
  'Pay your transport bill and submit the transaction details for verification.',
  '','Open payment','Bills','ALL','PINK',10,1,now()::text,now()::text),
 ('00000000-0000-4000-8000-000000000002','Live Tracking','Follow the journey',
  'See the latest available vehicle location from your dashboard.',
  '','View location','LiveTracking','ALL','BLUE',20,1,now()::text,now()::text),
 ('00000000-0000-4000-8000-000000000003','Vehicle safety','Safe Journey, Bright Future',
  'Important transport updates and safety information will appear here.',
  '','View updates','Inbox','ALL','GREEN',30,1,now()::text,now()::text)
 ON CONFLICT (id) DO NOTHING;
`;
