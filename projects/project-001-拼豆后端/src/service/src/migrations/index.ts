import * as migration_20260818_161323_init_users from './20260818_161323_init_users';

export const migrations = [
  {
    up: migration_20260818_161323_init_users.up,
    down: migration_20260818_161323_init_users.down,
    name: '20260818_161323_init_users'
  },
];
