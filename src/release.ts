// Which release of the site is running. `npm run deploy` stamps these in at build time (wrangler --define);
// anywhere else (wrangler dev, tests, a bare `wrangler deploy`) they are absent and the site says so.
declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;
declare const __APP_RELEASED__: string | undefined;

export const REPO_URL = 'https://github.com/OptimizedFunction/prun-galactic-credit-bureau';

export interface Release {
  /** From package.json, e.g. "0.2.0". Null on a build that was not made by `npm run deploy`. */
  version: string | null;
  /** Short git commit, with "+changes" when uncommitted work was deployed. */
  commit: string | null;
  /** When it was deployed, ISO 8601. */
  releasedAt: string | null;
}

export const RELEASE: Release = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null,
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : null,
  releasedAt: typeof __APP_RELEASED__ === 'string' ? __APP_RELEASED__ : null,
};

/** "0.2.0+7ec716a", or "dev" for an unstamped build. Sent with every response as X-Bureau-Version. */
export const releaseTag = (r: Release = RELEASE): string => (r.version ? `${r.version}${r.commit ? `+${r.commit}` : ''}` : 'dev');

/** Link to the commit on GitHub, when it is a clean one. */
export const commitUrl = (r: Release = RELEASE): string | null => (r.commit && /^[0-9a-f]{7,40}$/.test(r.commit) ? `${REPO_URL}/commit/${r.commit}` : null);
