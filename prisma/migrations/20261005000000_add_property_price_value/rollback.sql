-- Manual rollback for the M05 shadow-column migration. The display string was
-- never changed, so restoring its index and dropping the derived column loses no
-- property data. MySQL DDL auto-commits.
CREATE INDEX `Property_price_idx` ON `Property` (`price`);
CREATE INDEX `Property_deactivate_adminapproval_blocked_user_adminblock_idx`
  ON `Property` (`deactivate`, `adminapproval`, `blocked_user`, `adminblock`);
DROP INDEX `Property_visibility_price_idx` ON `Property`;
ALTER TABLE `Property` DROP COLUMN `priceValue`;
