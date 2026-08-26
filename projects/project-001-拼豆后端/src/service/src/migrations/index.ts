import * as migration_20260818_161323_init_users from './20260818_161323_init_users';
import * as migration_20260818_232836_m1_user_account_fields from './20260818_232836_m1_user_account_fields';
import * as migration_20260819_101810_m1_better_auth from './20260819_101810_m1_better_auth';
import * as migration_20260820_143322_m1_login_security from './20260820_143322_m1_login_security';
import * as migration_20260820_153723_m1_work_models from './20260820_153723_m1_work_models';
import * as migration_20260821_130300_m1_work_activation_guard from './20260821_130300_m1_work_activation_guard';
import * as migration_20260821_215000_m1_work_revision_guard from './20260821_215000_m1_work_revision_guard';
import * as migration_20260821_231500_m1_active_work_advisory_lock from './20260821_231500_m1_active_work_advisory_lock';
import * as migration_20260822_103000_m1_audit_and_abuse_controls from './20260822_103000_m1_audit_and_abuse_controls';
import * as migration_20260822_141000_m11_inventory_ledger from './20260822_141000_m11_inventory_ledger';
import * as migration_20260822_201000_m11_inventory_import_previews from './20260822_201000_m11_inventory_import_previews';
import * as migration_20260825_120000_m2_library_community from './20260825_120000_m2_library_community';
import * as migration_20260825_160000_m2_work_withdraw_transition_fix from './20260825_160000_m2_work_withdraw_transition_fix';
import * as migration_20260826_042051_m21_content_drafts from './20260826_042051_m21_content_drafts';
import * as migration_20260826_103000_m11_inventory_rules from './20260826_103000_m11_inventory_rules';

export const migrations = [
  {
    up: migration_20260818_161323_init_users.up,
    down: migration_20260818_161323_init_users.down,
    name: '20260818_161323_init_users',
  },
  {
    up: migration_20260818_232836_m1_user_account_fields.up,
    down: migration_20260818_232836_m1_user_account_fields.down,
    name: '20260818_232836_m1_user_account_fields',
  },
  {
    up: migration_20260819_101810_m1_better_auth.up,
    down: migration_20260819_101810_m1_better_auth.down,
    name: '20260819_101810_m1_better_auth',
  },
  {
    up: migration_20260820_143322_m1_login_security.up,
    down: migration_20260820_143322_m1_login_security.down,
    name: '20260820_143322_m1_login_security',
  },
  {
    up: migration_20260820_153723_m1_work_models.up,
    down: migration_20260820_153723_m1_work_models.down,
    name: '20260820_153723_m1_work_models',
  },
  {
    up: migration_20260821_130300_m1_work_activation_guard.up,
    down: migration_20260821_130300_m1_work_activation_guard.down,
    name: '20260821_130300_m1_work_activation_guard'
  },
  {
    up: migration_20260821_215000_m1_work_revision_guard.up,
    down: migration_20260821_215000_m1_work_revision_guard.down,
    name: '20260821_215000_m1_work_revision_guard'
  },
  {
    up: migration_20260821_231500_m1_active_work_advisory_lock.up,
    down: migration_20260821_231500_m1_active_work_advisory_lock.down,
    name: '20260821_231500_m1_active_work_advisory_lock'
  },
  {
    up: migration_20260822_103000_m1_audit_and_abuse_controls.up,
    down: migration_20260822_103000_m1_audit_and_abuse_controls.down,
    name: '20260822_103000_m1_audit_and_abuse_controls'
  },
  {
    up: migration_20260822_141000_m11_inventory_ledger.up,
    down: migration_20260822_141000_m11_inventory_ledger.down,
    name: '20260822_141000_m11_inventory_ledger'
  },
  {
    up: migration_20260822_201000_m11_inventory_import_previews.up,
    down: migration_20260822_201000_m11_inventory_import_previews.down,
    name: '20260822_201000_m11_inventory_import_previews'
  },
  {
    up: migration_20260825_120000_m2_library_community.up,
    down: migration_20260825_120000_m2_library_community.down,
    name: '20260825_120000_m2_library_community'
  },
  {
    up: migration_20260825_160000_m2_work_withdraw_transition_fix.up,
    down: migration_20260825_160000_m2_work_withdraw_transition_fix.down,
    name: '20260825_160000_m2_work_withdraw_transition_fix',
  },
  {
    up: migration_20260826_042051_m21_content_drafts.up,
    down: migration_20260826_042051_m21_content_drafts.down,
    name: '20260826_042051_m21_content_drafts',
  },
  {
    up: migration_20260826_103000_m11_inventory_rules.up,
    down: migration_20260826_103000_m11_inventory_rules.down,
    name: '20260826_103000_m11_inventory_rules'
  },
];
