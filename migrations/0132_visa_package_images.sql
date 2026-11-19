-- Every visa package has an image (admin Create Visa → the pop-up), shown on
-- the admin card and on the agent "Apply for Visa" package cards. Required
-- for new packages and whenever a package is saved (visaPackages.controller.js);
-- NULL only for packages made before this — they get one on their next edit.
ALTER TABLE visa_packages
  ADD COLUMN image_url TEXT NULL AFTER max_stay_days;
