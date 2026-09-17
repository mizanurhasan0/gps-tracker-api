/** Version 6 converts dashboard banners to image-only redirect cards. */
export const bannerLinksSchema = `
ALTER TABLE banners ADD COLUMN "redirectUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE banners ALTER COLUMN title SET DEFAULT '';
UPDATE banners SET active=0 WHERE "imageUrl"='';
`;
