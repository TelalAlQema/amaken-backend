-- M05: numeric price shadow column. `price` remains the display source, so a
-- rollback only drops this derived column and its index; no user data is lost.
--
-- Before applying this migration to any production database, restore a copy and
-- run the same audit query documented in docs/milestones/M05-property-domain.md.
-- MySQL DDL auto-commits; the migration itself is forward-only.
ALTER TABLE `Property`
  ADD COLUMN `priceValue` DECIMAL(14,2) NULL;

-- Only accept plain decimal values with correctly grouped thousands separators
-- and an optional recognized currency prefix/suffix. All other original strings
-- remain untouched and their numeric counterpart stays NULL for manual review.
UPDATE `Property`
SET `priceValue` = CAST(
  REGEXP_REPLACE(`price`, '[[:space:],$€£A-Za-z]', '') AS DECIMAL(14,2)
)
WHERE TRIM(`price`) REGEXP '^(AED|USD|EUR|GBP|[$€£])?[[:space:]]*([0-9]{1,12}|[0-9]{1,3}(,[0-9]{3}){1,3})(\\.[0-9]{1,2})?[[:space:]]*(AED|USD|EUR|GBP|[$€£])?$';

CREATE INDEX `Property_visibility_price_idx`
  ON `Property` (`deactivate`, `adminapproval`, `blocked_user`, `adminblock`, `priceValue`);

DROP INDEX `Property_price_idx` ON `Property`;
DROP INDEX `Property_deactivate_adminapproval_blocked_user_adminblock_idx` ON `Property`;
