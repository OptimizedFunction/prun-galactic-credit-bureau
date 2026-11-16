export interface Env {
  DB: D1Database;
  /** FIO API key of the bureau's FIO account. Secret; unset means the sync does nothing. */
  FIO_API_KEY?: string;
  /** Days past maturity after which an unresolved loan is marked Stale. Default 91. */
  STALE_GRACE_DAYS?: string;
}
