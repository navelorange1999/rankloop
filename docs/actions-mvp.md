# GitHub Actions monitoring MVP

This is the implemented first slice of the broader platform design. It requires no Web service, database, worker host, Redis, or new queue. GSC ingestion and real GEO answer sampling remain unimplemented.

## Verified architecture

The website repository contains independent Next.js 15 `www` and Payload CMS 3 `admin` applications. Payload uses MongoDB. Separate Vercel projects deploy them: staging branch pushes create preview deployments; `www-v*` and `admin-v*` GitHub releases deploy the corresponding production app. The public `www` hostname redirects to the canonical apex origin.

Public CMS fetches use tagged Next.js data caching, with a 60-second default. Article reads explicitly use 60 seconds; catch-all pages also have generated static parameters. Preview reads bypass caching. Cache invalidation is lazy: a successful notification does not prove that a subsequent public response contains the new version. The existing Payload transaction creates a durable revalidation job; its existing Vercel queue wakes the consumer after commit. This implementation reuses that path.

## Publication flow

1. A public content change queues the existing revalidation job in the content transaction. Draft-only collection saves do not dispatch scans.
2. The committed job invalidates website caches through the existing authenticated endpoint.
3. When explicitly enabled in the production Admin deployment, the same job posts a `cms-publication` event to GitHub's authenticated `repository_dispatch` API. GitHub is the Webhook receiver. No anonymous receiver or separate HMAC relay is deployed.
4. Rankloop validates the event, discovers current published URLs through the no-store public `/api/seo/manifest`, and scans affected public paths. Page/Post changes select matching slugs and locales. Related content or site setting changes fan out across the selected locales. Old Page/Post slug routes are checked for removal or a valid redirect.
5. Each response must match both the expected content timestamp and a SHA-256 fingerprint of the resolved public document and site configuration. This includes resolved CMS relationships. A mismatched fingerprint refreshes the public manifest. Confirmed newer content is marked `superseded`; stale or missing markers never produce a successful version check.

The manifest returns public path, collection, slug, locale, timestamp and fingerprint only. It does not return bodies, CMS record IDs, drafts, or authentication data. It is dynamic, sends `Cache-Control: no-store`, and reads public CMS data without credentials. Failure or an over-budget inventory returns 503 instead of an incomplete inventory. Publication and withdrawal intent must agree with this inventory before retirement can pass. Sitemap membership is compared in both directions with bounded rediscovery retries.

## Reliability and compensation

- Cache invalidation and GitHub dispatch failures propagate to the existing Payload task's six exponential retry attempts. Dispatch retries may create duplicate workflow runs. Stable event IDs identify the logical change; run ID and attempt identify observations. Do not sum duplicate runs as independent changes.
- A 204 from GitHub means accepted, not scan success. The Actions result is the scan outcome. Re-run failed jobs to retain the original event, or use manual dispatch to scan current state.
- Live revision checks wait at most six attempts with delays of 0, 5, 15, 30, 60 and 120 seconds. Request timeouts are 20 seconds. Bounded Retry-After is respected for page-level 429/503 responses.
- A daily run at 03:23 UTC and manual dispatch scan the entire current manifest. This compensates for lost hooks, exhausted notifications and code deployments. It cannot reconstruct intermediate publications or previously unknown deleted URLs.
- Scans run sequentially, with at least 500ms between production requests and the applicable robots crawl delay. Limits: 200 selected pages, 4,000 manifest entries, 2MB per response, and a 20-minute scan budget inside a 25-minute job. Exceeding a limit fails visibly rather than silently truncating results.
- Production requests are pinned to the canonical origin, with DNS public-address validation and connection pinning. Redirects are same-origin and bounded. No credentials accompany public page requests. Fixture mode can reach only `127.0.0.1:3000`.

## Reports and checks

`scan.json` records expected and observed versions, fingerprints, attempts, HTTP status, deterministic findings, content hash and readiness signals. It stores no HTML bodies. Summary and JSON are uploaded on success and failure and retained for 90 days. Reports are Actions artifacts, not a persistent metrics database; export selected runs before retention expires if longer history is needed. Access to a public repository's workflow artifacts follows GitHub's repository access model.

Blocking checks cover status/version confirmation, title, description, canonical, noindex, language, robots access and sitemap inclusion. Warnings cover heading count, missing image alt text, missing structured data and short server-rendered content. Next.js streaming redirects are accepted only after checking the live destination fingerprint. Streaming not-found responses with HTTP 200, noindex, and no publication markers are recorded as soft-404 warnings, not successful HTTP deletion. Readiness signals are not GEO exposure or ranking metrics.

The website PR workflow builds the PR merge revision against a synthetic public Payload fixture, scans the built HTML, and runs Lighthouse CI against home, an English technical article and a Chinese trading article. SEO must score at least 0.90; performance and accessibility thresholds are advisory. It uses a pinned scanner commit, no production CMS credentials, no Vercel deployment credentials and no `pull_request_target` execution.

## Configuration and rollout

1. Merge the rankloop workflow to its default branch so `repository_dispatch` and scheduling can run. The website workflow pins the reviewed scanner commit.
2. Merge and deploy WWW first, using the existing release process. Verify `/api/seo/manifest` and rendered `rankloop-revision` / `rankloop-fingerprint` metadata agree. Run rankloop manually and inspect the artifact.
3. Deploy Admin. In its production Vercel project, configure `RANKLOOP_ENABLED=true`, `RANKLOOP_REPOSITORY=<owner>/<repository>`, and secret `RANKLOOP_DISPATCH_TOKEN`. Leave the flag off in previews. `VERCEL_ENV=production` is also mandatory; Vercel supplies it.
4. The dispatch credential is a fine-grained PAT restricted to the rankloop repository with **Contents: write**, or a GitHub App installation credential with equivalent repository permission. Metadata read accompanies repository access. No administration or workflow-file write permission is needed. Installation credentials expire and require an operator-managed issuance mechanism; a scoped PAT is the simpler MVP choice.
5. Keep the existing `WWW_INTERNAL_SECRET` configuration between Admin and WWW. Do not copy this secret into rankloop. Rankloop's new workflows only require the normal read-only `GITHUB_TOKEN`; public scanning needs no extra Secrets.
6. Check that Actions is enabled in both repositories and permit the official checkout, setup-node and artifact actions. Optionally require `Technical SEO and Lighthouse / seo` in website branch protection and `Scanner tests / test` in rankloop protection.
7. Publish one reviewed existing content edit, verify the corresponding event run and matching version, then restore editorial content if appropriate. This smoke test requires an actual authorized publication; a fixture pass alone does not prove production credentials or Vercel delivery are configured.

Disabling `RANKLOOP_ENABLED` stops new CMS dispatches without disabling existing cache invalidation. The scheduled scanner can remain enabled. No new database migration is required: the optional revision lives in Payload's existing JSON job input.

## Local validation

Use Node.js 24.22.1, `npm ci --ignore-scripts`, and `npm test`. The production-only workflow installs with `--omit=dev`. Lighthouse CI is pinned to 0.15.1; tested overrides bring its Lighthouse and helper dependencies to patched versions. The lockfile is committed.

The website's `postman/simulations/seo/seo.sim.yaml` runs the same synthetic public CMS handler used directly by CI. It covers the called read contracts and returns 501 for unmodeled endpoints. It does not model Vercel caching or CMS transactions. `node scripts/scan.mjs --fixture` scans the locally built website; `--baseline` audits the currently deployed website without claiming version confirmation.

## Next integrations

GSC: provision a read-only property authorization, verify property ownership, then ingest site totals, page aggregates and query detail separately. Start with a bounded backfill and a rolling recent-date refresh; retain source dates, collection times, completeness and preliminary/final data state. Add URL Inspection only for a small prioritized URL set within quota. A technical SEO pass is not proof that Google indexed a URL.

GEO: version a small fixed question set, locale, provider/model and search mode. Record actual returned citations separately from consulted search sources and brand mentions. Repeat samples, track configuration changes, and label API-based samples separately from consumer product exposure. Add budgets and credentials only after provider capability validation. No model calls, paid API requests, or automatic content edits are included here.

References: [GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event), [Next.js 15 cache invalidation](https://nextjs.org/docs/15/app/api-reference/functions/revalidateTag), [Lighthouse CI configuration](https://googlechrome.github.io/lighthouse-ci/docs/configuration.html).
