export interface Env {
  DB: D1Database;
  /** FIO API key of the bureau's own FIO account, for lenders who granted it contract permission. Secret, optional. */
  FIO_API_KEY?: string;
  /** Encrypts the FIO API keys lenders connect. Secret; unset means lenders cannot connect a key. Changing it makes stored keys unreadable. */
  FIO_KEY_SECRET?: string;
  /** Discord OAuth application, for sign-in. Unset means nobody can sign in or edit. */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Discord user IDs of maintainers, comma-separated. They can block accounts and roll back their changes. */
  ADMIN_DISCORD_IDS?: string;
  /** Days past maturity after which an unresolved loan is marked Stale. Default 91. */
  STALE_GRACE_DAYS?: string;
}
