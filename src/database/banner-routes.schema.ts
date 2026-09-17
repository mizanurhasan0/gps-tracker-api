/** Version 7 changes banner actions to safe in-app routes and adds optional timing. */
export const bannerRoutesSchema = `
ALTER TABLE banners ADD COLUMN "redirectRoute" TEXT NOT NULL DEFAULT '';
ALTER TABLE banners ADD COLUMN "sliderDuration" INTEGER;
ALTER TABLE banners ADD CONSTRAINT banners_slider_duration_check
  CHECK ("sliderDuration" IS NULL OR "sliderDuration" BETWEEN 1 AND 60);
UPDATE banners SET active=0 WHERE "redirectRoute"='';
`;
