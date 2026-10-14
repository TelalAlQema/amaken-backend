-- One-time normalisation of the legacy PHP data so the typed Prisma schema
-- can be applied with `prisma db push`. Legacy stored every value as a string
-- (empty strings, "DD-Mon-Weekday HH:MM:SS" dates) and has orphaned FKs.

-- 1. Numeric columns: "" -> 0 / NULL, non-numeric -> 0
UPDATE `user` SET
  `deactivate`   = COALESCE(NULLIF(TRIM(`deactivate`),  ''), 1) + 0,
  `uloginvalue`  = COALESCE(NULLIF(TRIM(`uloginvalue`), ''), 0) + 0,
  `adminblock`   = COALESCE(NULLIF(TRIM(`adminblock`),  ''), 0) + 0;

UPDATE `admin` SET
  `adeactivate`  = COALESCE(NULLIF(TRIM(`adeactivate`), ''), 0) + 0,
  `aloginvalue`  = COALESCE(NULLIF(TRIM(`aloginvalue`), ''), 0) + 0,
  `adminblock`   = COALESCE(NULLIF(TRIM(`adminblock`),  ''), 0) + 0;

UPDATE `property` SET
  `isFeatured`   = COALESCE(NULLIF(TRIM(`isFeatured`),   ''), 0) + 0,
  `offer`        = COALESCE(NULLIF(TRIM(`offer`),        ''), 0) + 0,
  `saleid`       = COALESCE(NULLIF(TRIM(`saleid`),       ''), 0) + 0,
  `deactivate`   = COALESCE(NULLIF(TRIM(`deactivate`),   ''), 1) + 0,
  `adminapproval`= COALESCE(NULLIF(TRIM(`adminapproval`),''), 0) + 0,
  `blocked_user` = COALESCE(NULLIF(TRIM(`blocked_user`), ''), 1) + 0,
  `adminblock`   = COALESCE(NULLIF(TRIM(`adminblock`),   ''), 0) + 0,
  `uid`          = COALESCE(NULLIF(TRIM(`uid`),          ''), 0) + 0;

UPDATE `feedback` SET
  `status`      = COALESCE(NULLIF(TRIM(`status`),      ''), 0) + 0,
  `rating`      = COALESCE(NULLIF(TRIM(`rating`),      ''), 0) + 0.0,
  `fblock`      = COALESCE(NULLIF(TRIM(`fblock`),      ''), 1) + 0,
  `fdeactivate` = COALESCE(NULLIF(TRIM(`fdeactivate`), ''), 1) + 0,
  `fadminblock` = COALESCE(NULLIF(TRIM(`fadminblock`), ''), 0) + 0,
  `agid`        = NULLIF(TRIM(`agid`), '') + 0;

UPDATE `city`           SET `sid` = COALESCE(NULLIF(TRIM(`sid`), ''), 0) + 0;
UPDATE `property_leads` SET `pid` = COALESCE(NULLIF(TRIM(`pid`), ''), 0) + 0;

-- 2. Required-but-NULL strings
UPDATE `newmember` SET
  `wnumber` = COALESCE(`wnumber`, ''),
  `pnumber` = COALESCE(`pnumber`, '');

-- 3. Dates: real datetimes pass through; the legacy "DD-Mon-Weekday HH:MM:SS"
--    (no year) is parsed with a placeholder year, anything unparseable -> now.
UPDATE `feedback` SET `created_at` =
  CASE WHEN `created_at` REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
       THEN STR_TO_DATE(`created_at`, '%Y-%m-%d %H:%i:%s')
       ELSE NOW() END;
UPDATE `delaccount` SET `date` =
  CASE WHEN `date` REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         THEN STR_TO_DATE(`date`, '%Y-%m-%d %H:%i:%s')
       WHEN `date` REGEXP '^[0-9]{1,2}-[A-Za-z]{3}-[A-Za-z]{3} '
         THEN STR_TO_DATE(CONCAT(SUBSTRING_INDEX(`date`, ' ', 1), ' 2025 ', SUBSTRING_INDEX(`date`, ' ', -1)),
                          '%d-%b-%a %Y %H:%i:%s')
       ELSE NOW() END;

-- 4. Orphaned foreign keys.
--    Property.uid -> user.uid (legacy unowned rows carry uid = 0)
UPDATE `property` SET `uid` = (SELECT MIN(`uid`) FROM `user`)
WHERE `uid` NOT IN (SELECT `uid` FROM `user`);
--    Property.aemail -> admin.aemail (nullable)
UPDATE `property` SET `aemail` = NULL
WHERE `aemail` IS NOT NULL AND TRIM(`aemail`) <> ''
  AND `aemail` NOT IN (SELECT `aemail` FROM `admin`);
--    Feedback.agid -> admin.aid (nullable)
UPDATE `feedback` SET `agid` = NULL
WHERE `agid` IS NOT NULL AND `agid` NOT IN (SELECT `aid` FROM `admin`);
--    Feedback.uid -> user.uid (nullable)
UPDATE `feedback` SET `uid` = NULL
WHERE `uid` IS NOT NULL AND `uid` NOT IN (SELECT `uid` FROM `user`);
--    PropertyLead.pid -> property.id (required; drop orphans)
DELETE FROM `property_leads` WHERE `pid` NOT IN (SELECT `id` FROM `property`);
