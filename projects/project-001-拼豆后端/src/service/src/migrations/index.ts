import * as migration_20260818_161323_init_users from './20260818_161323_init_users';
import * as migration_20260818_232836_m1_user_account_fields from './20260818_232836_m1_user_account_fields';

export const migrations = [
  {
    up: migration_20260818_161323_init_users.up,
    down: migration_20260818_161323_init_users.down,
    name: '20260818_161323_init_users',
  },
  {
    up: migration_20260818_232836_m1_user_account_fields.up,
    down: migration_20260818_232836_m1_user_account_fields.down,
    name: '20260818_232836_m1_user_account_fields'
  },
];
