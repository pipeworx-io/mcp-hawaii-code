interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Hawaii Revised Statutes — state statutes by citation, by topic, and
 * (where the Legislature itself publishes it) by historical year. Fleet
 * #2751.
 *
 * SOURCE AND SHAPE. www.capitol.hawaii.gov/hrscurrent/ is a plain directory
 * tree with no combined index page and no search API:
 *   /hrscurrent/Vol{NN}_Ch{range}/HRS{chapterNum}/HRS_{chapterNum}-{section}.htm
 * Each chapter directory also carries `HRS_{chapterNum}-.htm` — the
 * chapter's own official table of contents (every section number + its
 * official catchline). That page is fetched ONCE per chapter by
 * `scripts/bake-index.mjs` into `hi-index-data.ts`; this file resolves a
 * citation to its exact URL from that baked table (falling back to a live
 * directory listing if a section was added/renumbered since the last bake —
 * see `resolveSectionUrl` below) and fetches/parses the one section page a
 * caller actually asked for. hi_search runs entirely off the baked table —
 * no network.
 *
 * THE WAF, AND WHY THIS PACK NEEDS NO EGRESS RELAY (the opposite of
 * oklahoma-code/utah-code). capitol.hawaii.gov sits behind Cloudflare and
 * its WAF returns a "Sorry, you have been blocked" 403 to every request from
 * this fleet's laptop/office IP — reproduced with a dozen UA/Accept/
 * Accept-Language combinations, 0 passes, including a full real-Chrome
 * header set. A throwaway `wrangler dev --remote` Worker on the prod
 * Cloudflare account fetching the SAME URLs got clean 200s every time
 * (cache HIT and MISS, a dozen distinct real pages) — the Worker is the
 * client that gets through, the laptop is the one that doesn't. That is
 * exactly backwards from the oscn.net/oklahoma-code case (Worker blocked,
 * browser fine), so the fix is backwards too: nothing extra is needed here.
 * The GATEWAY itself is a Cloudflare Worker, so its live calls need no relay
 * — only the one-time local bake (run from a laptop) does; see that
 * script's header.
 *
 * CHARSET. hrscurrent pages declare charset=utf-8; the HISTORICAL archive
 * (/hrsarchive/hrs{YYYY}/, confirmed live 1999-2025) serves OLDER years as
 * windows-1252 with no charset in the HTTP header at all (only in the HTML
 * <meta> tag) — decoding every page as UTF-8 regardless would silently
 * mangle every §, em dash and curly quote in an archived page the same way
 * a charset bug once did to oscn.net through the shared egress relay (fleet
 * #2742). `sniffAndDecode` below reads the <meta charset> declaration from
 * the raw bytes before choosing a decoder, on every fetch.
 *
 * THE CUSTOM "NOT FOUND" TRAP. A citation that doesn't exist gets HTTP 200
 * with the SITE'S OWN generic IIS/ASP.NET 404 page (meta charset=iso-8859-2,
 * stylesheet /screen.css) — not a 404 status, not the statute template. A
 * status-code check alone would read every missing citation as a transport
 * success with nothing to parse. `isNotFoundPage`/`isStatutePage` below tell
 * that apart from a genuine parse failure (statute template present, heading
 * regex still failed — LOUD error, never silent found:false) and from a
 * Cloudflare block page (also LOUD, never found:false — see
 * `isBlockedPage`).
 *
 * FOUR CAPABILITIES:
 *   - section by citation       -> hi_statute
 *   - topic/keyword search      -> hi_search, over official CATCHLINES from
 *     the baked chapter TOC pages (caption-level search — Hawaii publishes
 *     no full-text search of statutory body text; labelled as such in the
 *     tool description and every response)
 *   - historical version        -> hi_statute({citation, year}), 1999-2025
 *     confirmed live against the SAME tree under /hrsarchive/hrs{YYYY}/
 *   - amendments/history        -> included inline: every current HRS
 *     section ends its own text with a "[L 1972, c 9, ...; am L 1986, ...]"
 *     legislative-history bracket (session law chapter/section citations per
 *     amendment) — `amendments_history` below extracts and splits it rather
 *     than leaving it buried in `text`. A section with no such bracket
 *     (rare, usually a very old or newly enacted one) says so explicitly
 *     rather than omitting the field.
 *
 * Keyless, no signup.
 */
import type { HiChapterRow, HiSectionRow } from './hi-index-data.js';

// fleet #2754 (LIVE INCIDENT 2026-10-07): this index used to be a STATIC
// import, so every gateway isolate evaluated it at startup whether or not it
// ever served a hawaii-code call — ~48MB of retained heap for the six baked state
// codes together, ~13.4MB of the bundle, and about one gateway call in four
// died as Cloudflare 1102 on cold isolates. The data module is now uploaded
// to KV at deploy (workers/gateway/src/pack-baked-indexes.json registers it;
// scripts/sync-gateway-static-json.mjs uploads it) and the gateway injects
// the parsed object as `args._bakedIndex` on every call into this pack.
// It is adopted once and kept for the isolate's life.
//
// NEVER value-import ./hi-index-data.js here again — a type-only import is
// erased, a value import puts the whole table back into every isolate. The
// deploy workflow's bundle-size ceiling fails the deploy if that happens.
let HI_CHAPTERS: HiChapterRow[] = [];
let HI_SECTIONS: HiSectionRow[] = [];
let HI_INDEX_CAPTURED_AT = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (HI_SECTIONS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const chapters = idx?.HI_CHAPTERS;
  const sections = idx?.HI_SECTIONS;
  const capturedAt = idx?.HI_INDEX_CAPTURED_AT;
  if (!Array.isArray(chapters) || !Array.isArray(sections) || sections.length === 0 || typeof capturedAt !== 'string') {
    // Loud on purpose: answering from an empty table would read as "no such
    // section" / "no match", a silent wrong answer.
    throw new Error(
      `hawaii-code: the baked section index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad citation or query — retry shortly.',
    );
  }
  HI_CHAPTERS = chapters as HiChapterRow[];
  HI_SECTIONS = sections as HiSectionRow[];
  HI_INDEX_CAPTURED_AT = capturedAt;
}

const UA = 'pipeworx-mcp-hawaii-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Hawaii Legislative Reference Bureau (capitol.hawaii.gov)';
const CURRENT_BASE = 'https://www.capitol.hawaii.gov/hrscurrent';
const ARCHIVE_BASE = 'https://www.capitol.hawaii.gov/hrsarchive';
const ARCHIVE_YEARS = { min: 1999, max: 2025 }; // confirmed live range; a year outside it is rejected before any fetch

async function pwFetch(url: string): Promise<{ status: number; buf: ArrayBuffer }> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, UPSTREAM);
  // A non-2xx that ISN'T the Cloudflare block page (that one is still a 200 — see below)
  // is a genuine transport failure and must say so loudly, never read as found:false.
  if (!res.ok && res.status !== 404) throw await httpError(res, UPSTREAM);
  const buf = await res.arrayBuffer();
  return { status: res.status, buf };
}

/** Read the <meta charset> declaration from the raw bytes and decode with it.
 *  hrscurrent is utf-8; older hrsarchive years are windows-1252 with NO
 *  charset in the HTTP header — only in this meta tag. Defaults to utf-8 if
 *  no declaration is found (safe: ASCII is a subset of both). */
function sniffAndDecode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  const m = /charset=["']?([\w-]+)/i.exec(head);
  const charset = (m?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeEntities(s: string): string {
  return s
    // A generic decimal numeric-entity decode, for anything the named list
    // below doesn't name — added for fleet #2753: the 1999-2005-era archive
    // pages use `&#9;` (a literal TAB character) for indentation instead of
    // leading spaces, which rendered as the LITERAL TEXT "&#9;" in every
    // historical section's body until this existed (confirmed live:
    // hi_statute({citation:'521-44', year:2005}) returned
    // "&#9;(1)&#9;Remedy tenant defaults..." instead of "(1) Remedy tenant
    // defaults..."). Runs first so the whitespace-collapse below treats a
    // decoded tab/nbsp the same as any other space; the named numeric
    // entities this subsumes (em/en dash, curly quotes, section sign,
    // apostrophe) are left as a comment rather than dead code: &#8212;
    // &#8211; &#8217; &#8216; &#8220; &#8221; &#167; &#39;.
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}

const BLOCK_SIGNATURES = ['Sorry, you have been blocked', 'Attention Required! | Cloudflare', 'cf-error-details'];

// Pre-~2012 archived HRS pages carry no CSS classes at all, so the
// cross-reference/commentary section that follows a section's operative
// text is marked only by a centered, plain-text heading — confirmed live
// on hrsarchive/hrs2005 ("Case Notes", "Hawaii Legal Reporter Citations").
// The current/~2012+ template uses the same CONCEPT of headings (Cross
// References, COMMENTARY ON ..., Case Notes, Law Journals and Reviews,
// Attorney General Opinions) but marks them with the XNotesHeading CSS
// class instead — this list is the unclassed fallback. NOT gated on the
// block's own `bold` flag: the archived page's "<B>" wraps the "<P>"
// element itself (`<B><P ALIGN="CENTER">Case Notes</P></B>`) rather than
// nesting inside it, so a block built only from inside the <p>...</p> pair
// never sees that surrounding bold at all — these phrases are distinctive
// enough on their own that requiring bold buys nothing but a missed match.
const ANNOTATION_HEADING_RE =
  /^(Case Notes|Cross References?|COMMENTARY(\s+ON\s+[0-9A-Za-z.\-]+)?|Hawaii Legal Reporter Citations|Law Journals? and Reviews?|Attorney General Opinions?)\s*$/i;
function isBlockedPage(html: string): boolean {
  return BLOCK_SIGNATURES.some((sig) => html.includes(sig));
}

/** The site's OWN generic 404 (served as HTTP 200) for any path that doesn't
 *  exist — identified by ITS OWN markup (the IIS/ASP.NET error template's
 *  `/screen.css` stylesheet, confirmed identical across hrscurrent and every
 *  hrsarchive year tried: 1999-2025), never by the ABSENCE of a real
 *  template's markers. An earlier version checked for the absence of
 *  `WordSection1`/`hrs.css` instead — those are only the CURRENT (2015+)
 *  template; archived years before roughly 2012 use a different template
 *  entirely (`class=Section1`, no stylesheet link at all, confirmed live on
 *  2010) and a 1999-2005-era Word-97 export has no classes or stylesheet of
 *  any kind. The old check read every one of those genuinely-found pages as
 *  "not found" — a silent failure fixed by fleet #2753: hi_statute with
 *  `year: 2010` or `year: 2005` returned section_not_found for sections that
 *  were actually fetched successfully and sitting right there in `html`. */
function isNotFoundPage(html: string): boolean {
  return html.includes('/screen.css');
}

interface ParsedSection {
  heading: string;
  catchline: string;
  bodyText: string;
  historyBracket: string | null;
}

/** Parse one real statute section page: heading ("§707-701  Murder in the
 *  first degree."), body (every RegularParagraphs block up to the first
 *  XNotes-class block — cross-references/commentary/case notes, not part of
 *  the statute's own text), and the trailing "[L ...]" legislative-history
 *  bracket embedded in the body (not a separate field in the source — HRS
 *  always appends it to the section's own last paragraph). */
function parseSectionPage(html: string): ParsedSection | null {
  const blocks: Array<{ cls: string; bold: boolean; raw: string; text: string }> = [];
  const pRe = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  for (let m = pRe.exec(html); m; m = pRe.exec(html)) {
    const cls = /class=["']?([\w]+)/i.exec(m[1])?.[1] ?? '';
    blocks.push({ cls, raw: m[2]!, bold: /<b>/i.test(m[2]!), text: decodeEntities(stripTags(m[2]!)) });
  }

  // The heading ("§707-701  Murder in the first degree.") and the section's
  // OPENING SENTENCE are routinely the SAME <p> block — HRS writes
  // "<b>§707-701  Murder...</b>  (1) A person commits..." as one paragraph.
  // Matching the heading regex against the whole flattened block text (as an
  // earlier version of this did) swallowed that opening sentence into
  // `catchline` and silently dropped it from the body — confirmed live,
  // 707-701's body started at "(a) More than one person..." instead of "(1)
  // A person commits the offense of murder... if the person ... causes the
  // death of:". So the heading is read from ONLY the content inside the
  // first <b>...</b> span in the RAW block, and whatever text follows that
  // closing tag in the SAME block becomes the first piece of the body.
  let headingIdx = -1;
  let heading = '';
  let catchline = '';
  let sameLineRemainder = '';
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i]!.bold) continue;
    const bm = /<b>([\s\S]*?)<\/b>([\s\S]*)$/i.exec(blocks[i]!.raw);
    if (!bm) continue;
    const boldText = decodeEntities(stripTags(bm[1]!));
    const hm = /§\s*([0-9A-Za-z.\-]+)\s+(.*?)\.?\s*$/.exec(boldText);
    if (hm) {
      headingIdx = i;
      heading = boldText;
      catchline = hm[2]!.trim();
      sameLineRemainder = decodeEntities(stripTags(bm[2]!));
      break;
    }
  }
  if (headingIdx < 0) return null;

  const bodyParts: string[] = [];
  if (sameLineRemainder) bodyParts.push(sameLineRemainder);
  for (let i = headingIdx + 1; i < blocks.length; i++) {
    const blk = blocks[i]!;
    // Current/~2012+ pages mark cross-references/commentary with the
    // XNotes/XNotesHeading CSS class (checked first — the common case). A
    // pre-~2012 archived page (confirmed live on 1999-2010-era years) uses
    // NO classes at all and marks the same material with a bold, centered,
    // UNCLASSED heading instead ("Case Notes", "Hawaii Legal Reporter
    // Citations", "COMMENTARY ON ...", etc.) — without this second check,
    // every one of those headings and everything after it was read as part
    // of the statute's own operative text.
    if (/^XNotes/i.test(blk.cls) || ANNOTATION_HEADING_RE.test(blk.text)) break;
    if (blk.text) bodyParts.push(blk.text);
  }
  const bodyText = bodyParts.join('\n\n').trim();

  const histMatches = bodyText.match(/\[L\s+[0-9][^\]]*\]/g);
  const historyBracket = histMatches && histMatches.length ? histMatches[histMatches.length - 1]! : null;

  return { heading, catchline, bodyText, historyBracket };
}

function normalizeCitation(raw: string): string {
  return raw
    .trim()
    .replace(/^(HRS|Haw\.?\s*Rev\.?\s*Stat\.?)\s*/i, '')
    .replace(/^§+\s*/, '')
    .replace(/\s+/g, '');
}

/** chapterNum -> HI_CHAPTERS index, built once. */
let chapterByNum: Map<string, number> | null = null;
function chapterIndex(): Map<string, number> {
  if (chapterByNum) return chapterByNum;
  const m = new Map<string, number>();
  HI_CHAPTERS.forEach((row, i) => m.set(row.chapterNum.toUpperCase(), i));
  chapterByNum = m;
  return m;
}

/** Full citation ("707-701") -> HI_SECTIONS index, built once. */
let sectionByCitation: Map<string, number> | null = null;
function sectionIndex(): Map<string, number> {
  if (sectionByCitation) return sectionByCitation;
  const m = new Map<string, number>();
  HI_SECTIONS.forEach((row, i) => m.set(row[0].toLowerCase(), i));
  sectionByCitation = m;
  return m;
}

/** "707-701" -> {chapterNum:"707", sectionPart:"701"}. Chapter numbers can
 *  carry a letter suffix ("502C-1"); section parts can carry a decimal and/or
 *  a trailing letter ("69.5", "21.6"). */
function splitCitation(citation: string): { chapterNum: string; sectionPart: string } | null {
  const m = /^([0-9]+[A-Za-z]*)-([0-9][0-9A-Za-z.]*)$/.exec(citation);
  if (!m) return null;
  return { chapterNum: m[1]!, sectionPart: m[2]! };
}

/** sectionPart ("69.5") -> the filename HRS encodes it as
 *  ("HRS_0521-0069_0005.htm") — confirmed against every chapter in the bake
 *  (17,900+ sections, 0 encode failures). Decimal digits and the main number
 *  are both zero-padded to 4; a trailing letter (rare) is appended as-is. */
function encodeSectionFilename(chapterSuffix: string, sectionPart: string): string | null {
  const m = /^([0-9]+)(?:\.([0-9]+))?([A-Za-z]*)$/.exec(sectionPart);
  if (!m) return null;
  const main = m[1]!.padStart(4, '0');
  const decimal = m[2] ? `_${m[2].padStart(4, '0')}` : '';
  const letter = m[3] ?? '';
  return `HRS_${chapterSuffix}-${main}${decimal}${letter}.htm`;
}

/** Inverse of the above, for the self-heal fallback below — decode a real
 *  filename back into the section part HRS would cite it as. */
function decodeSectionFilename(filename: string, chapterSuffix: string): string | null {
  const esc = chapterSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^HRS_${esc}-([0-9]{4})(?:_([0-9]+))?([A-Za-z]*)\\.htm$`, 'i').exec(filename);
  if (!m) return null;
  const main = String(parseInt(m[1]!, 10));
  const decimal = m[2] ? `.${String(parseInt(m[2]!, 10))}` : '';
  return `${main}${decimal}${m[3] ?? ''}`;
}

interface Resolved {
  url: string;
  html: string;
}

/** Fetch a section, with one self-heal fallback: if the citation's GUESSED
 *  filename 404s or lands on the site's generic not-found page, fetch the
 *  chapter's live directory listing and look for a filename that decodes to
 *  the same section part — catches a section added/renumbered since the
 *  last bake, or a decimal/letter-suffix shape the encoder didn't predict,
 *  without ever trusting the baked table for the actual URL (same
 *  "verify live" posture mcps/idaho-code uses for its own computed URLs). */
async function resolveSectionUrl(base: string, chapter: HiChapterRow, sectionPart: string): Promise<Resolved | null> {
  const guessed = encodeSectionFilename(chapter.suffix, sectionPart);
  if (guessed) {
    const url = `${base}/${chapter.volumeDir}/${chapter.chapterDir}/${guessed}`;
    const { status, buf } = await pwFetch(url);
    if (status !== 404) {
      const html = sniffAndDecode(buf);
      if (isBlockedPage(html)) throw new Error(`upstream_blocked: ${UPSTREAM} returned a Cloudflare block page for ${url}.`);
      if (!isNotFoundPage(html)) return { url, html };
    }
  }

  // Self-heal: list the chapter directory live and find the real filename.
  const dirUrl = `${base}/${chapter.volumeDir}/${chapter.chapterDir}/`;
  const { status: dirStatus, buf: dirBuf } = await pwFetch(dirUrl);
  if (dirStatus === 404) return null;
  const dirHtml = sniffAndDecode(dirBuf);
  if (isBlockedPage(dirHtml)) throw new Error(`upstream_blocked: ${UPSTREAM} returned a Cloudflare block page for ${dirUrl}.`);
  const hrefRe = /HREF="([^"]+\/(HRS_[^"/]+\.htm))"/gi;
  for (let m = hrefRe.exec(dirHtml); m; m = hrefRe.exec(dirHtml)) {
    const decoded = decodeSectionFilename(m[2]!, chapter.suffix);
    if (decoded && decoded.toLowerCase() === sectionPart.toLowerCase()) {
      const url = m[1]!.startsWith('http') ? m[1]! : `${base}/${chapter.volumeDir}/${chapter.chapterDir}/${m[2]}`;
      const { buf } = await pwFetch(url);
      const html = sniffAndDecode(buf);
      if (isBlockedPage(html)) throw new Error(`upstream_blocked: ${UPSTREAM} returned a Cloudflare block page for ${url}.`);
      if (!isNotFoundPage(html)) return { url, html };
    }
  }
  return null;
}

async function hiStatute(args: Record<string, unknown>) {
  const raw = String(args.citation ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_citation',
      message: 'hi_statute needs a citation, e.g. "707-701" (murder in the first degree) or "521-44" (security deposits).',
    };
  }
  const citation = normalizeCitation(raw);
  const split = splitCitation(citation);
  if (!split) {
    return {
      found: false,
      reason: 'bad_citation_shape',
      citation: raw,
      message: `"${raw}" doesn't look like a Hawaii Revised Statutes citation. Expected "chapter-section", e.g. "707-701" or "521-44".`,
      hint: 'Call hi_search with a topic instead if you do not have an exact citation.',
    };
  }

  let yearArg: number | undefined;
  if (args.year !== undefined && args.year !== null && args.year !== '') {
    const y = Number(args.year);
    if (!Number.isInteger(y) || y < ARCHIVE_YEARS.min || y > ARCHIVE_YEARS.max) {
      return {
        found: false,
        reason: 'year_out_of_range',
        citation: raw,
        message: `"year" must be an integer between ${ARCHIVE_YEARS.min} and ${ARCHIVE_YEARS.max} (Hawaii's online historical archive range, confirmed live). Omit it for the current law.`,
      };
    }
    yearArg = y;
  }

  const chIdx = chapterIndex().get(split.chapterNum.toUpperCase());
  const secIdx = sectionIndex().get(citation.toLowerCase());
  const chapter = chIdx !== undefined ? HI_CHAPTERS[chIdx]! : secIdx !== undefined ? HI_CHAPTERS[HI_SECTIONS[secIdx]![2]]! : undefined;
  const bakedCatchline = secIdx !== undefined ? HI_SECTIONS[secIdx]![1] : undefined;

  if (!chapter) {
    const loose = citation.toLowerCase();
    const near = HI_SECTIONS.filter((r) => r[0].toLowerCase().startsWith(loose.split('-')[0]! + '-'))
      .slice(0, 5)
      .map((r) => ({ citation: r[0], catchline: r[1] }));
    return {
      found: false,
      reason: 'chapter_not_found',
      citation: raw,
      message: `No HRS chapter ${split.chapterNum} is in the Legislature's own chapter directory (checked ${HI_CHAPTERS.length} chapters, captured ${HI_INDEX_CAPTURED_AT}).`,
      near: near.length ? near : undefined,
      source: `${UPSTREAM}, keyless`,
    };
  }

  const base = yearArg ? `${ARCHIVE_BASE}/hrs${yearArg}` : CURRENT_BASE;
  let resolved: Resolved | null;
  try {
    resolved = await resolveSectionUrl(base, chapter, split.sectionPart);
  } catch (err) {
    throw err; // already a loud, named upstream_blocked error — propagate as-is
  }

  if (!resolved) {
    const near = HI_SECTIONS.filter((r) => r[2] === chIdx)
      .slice(0, 8)
      .map((r) => ({ citation: r[0], catchline: r[1] }));
    return {
      found: false,
      reason: 'section_not_found',
      citation: `HRS §${citation}`,
      chapter: chapter.chapterNum,
      chapter_name: chapter.chapterName,
      message: yearArg
        ? `No section "${citation}" was found in the ${yearArg} historical HRS archive for chapter ${chapter.chapterNum}.`
        : `No section "${citation}" was found in the current chapter ${chapter.chapterNum} directory (checked both the baked index and a live directory listing).`,
      near: near.length ? near : undefined,
      source: `${UPSTREAM}, keyless`,
    };
  }

  const parsed = parseSectionPage(resolved.html);
  if (!parsed) {
    // The page IS the statute template (isNotFoundPage already ruled out the
    // generic 404) but the heading regex found nothing — an unexpected shape,
    // never silently reported as found:false.
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned a page at ${resolved.url} that does not match the expected statute-section template (no bolded "§<citation> <catchline>" heading found). The page may have changed structure since this pack was written.`,
    );
  }

  const historyParts = parsed.historyBracket
    ? parsed.historyBracket
        .replace(/^\[|\]$/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    found: true,
    citation: `HRS §${citation}`,
    catchline: bakedCatchline || parsed.catchline,
    chapter: chapter.chapterNum,
    chapter_name: chapter.chapterName,
    text: parsed.bodyText,
    text_chars: parsed.bodyText.length,
    amendments_history: historyParts.length
      ? historyParts
      : 'No legislative-history bracket ("[L ...]") was found in this section\'s own text — Hawaii embeds that bracket at the end of a section\'s text when it carries one; its absence here means none is on record for this section (common for a very recently enacted or very old, never-amended section).',
    historical_versions: yearArg
      ? `This is the ${yearArg} archived version, from capitol.hawaii.gov's own year-by-year archive.`
      : 'This is the CURRENT version. Hawaii also publishes a full year-by-year online archive back to 1999 — pass "year" (e.g. 2015) to get that year\'s text of the same section.',
    year: yearArg ?? 'current',
    url: resolved.url,
    data_as_of: yearArg ? `${yearArg} archived text` : new Date().toISOString(),
    source: `${UPSTREAM}, keyless`,
    attribution: 'Hawaii Revised Statutes are public record.',
  };
}

interface SearchHit {
  citation: string;
  catchline: string;
  chapterIdx: number;
  score: number;
}

/** IDF-weighted word overlap over official catchlines (+ the section's own
 *  chapter name, for recall when the word lives in the chapter title rather
 *  than any one section's catchline) — same scoring shape as
 *  mcps/north-dakota-code's nd_search. */
function wordWeights(words: string[], haystacks: string[]): Map<string, number> {
  const weight = new Map<string, number>();
  for (const w of words) {
    let df = 0;
    for (const h of haystacks) if (h.includes(w)) df++;
    weight.set(w, 1 / Math.max(1, df));
  }
  return weight;
}

async function hiSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'hi_search needs a "query" — a topic or a few keywords, e.g. "landlord security deposit" or "murder".',
      hint: 'To look up a known citation directly, use hi_statute instead.',
    };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) {
    return { found: false, reason: 'query_too_short', query: q, message: `"${q}" has no word of 3+ characters to match against section catchlines.` };
  }

  const haystacks = HI_SECTIONS.map((r) => `${r[1]} ${HI_CHAPTERS[r[2]]!.chapterName}`.toLowerCase());
  const weight = wordWeights(words, haystacks);

  const hits: SearchHit[] = [];
  for (let i = 0; i < HI_SECTIONS.length; i++) {
    const h = haystacks[i]!;
    let score = 0;
    for (const w of words) if (h.includes(w)) score += weight.get(w) ?? 1;
    if (score > 0) hits.push({ citation: HI_SECTIONS[i]![0], catchline: HI_SECTIONS[i]![1], chapterIdx: HI_SECTIONS[i]![2], score });
  }
  hits.sort((a, b) => b.score - a.score);

  if (!hits.length) {
    return {
      found: false,
      query: q,
      message: `No section or chapter catchline in the Hawaii Revised Statutes matched "${q}".`,
      hint: 'This matches official CATCHLINES (section names + chapter titles), not full statutory text — Hawaii publishes no full-text search; try shorter or more literal terms.',
      sections_scanned: HI_SECTIONS.length,
      data_as_of: HI_INDEX_CAPTURED_AT,
    };
  }

  const results = hits.slice(0, limit).map((h) => {
    const chapter = HI_CHAPTERS[h.chapterIdx]!;
    return {
      citation: `HRS §${h.citation}`,
      section: h.citation,
      catchline: h.catchline,
      chapter: chapter.chapterNum,
      chapter_name: chapter.chapterName,
    };
  });

  return {
    found: true,
    query: q,
    count: results.length,
    total_matched: hits.length,
    results,
    hint: 'Call hi_statute with a citation above for the full text.',
    match_level: 'official_catchline',
    note: 'Caption-level search over official section catchlines and chapter titles — Hawaii does not publish a full-text search of statutory body text.',
    source: `${UPSTREAM} chapter table-of-contents index, keyless`,
    data_as_of: HI_INDEX_CAPTURED_AT,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'hi_statute',
    description:
      'Get the FULL TEXT of a section of the Hawaii Revised Statutes (HRS) — Hawaii state law — by citation. "707-701" is murder in the first degree; "521-44" is a landlord\'s security-deposit duty under the Residential Landlord-Tenant Code. Accepts natural forms: "707-701", "HRS 707-701", "§707-701". Returns the current statutory text, the official catchline, chapter context, and amendment/enactment history parsed from the Legislature\'s own "[L 1972, c 9, ...]" session-law bracket. Pass "year" (1999-2025) to get that year\'s historical archived text of the same section instead of the current one — Hawaii publishes a full year-by-year online archive. Keyless. Use for "what does HRS 707-701 say" or to check a Hawaii statute a case or lease relies on, now or as of a past year.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: {
          type: 'string',
          description: 'Section citation, chapter-section, e.g. "707-701" (murder) or "521-44" (security deposits). Some sections carry a decimal suffix, e.g. "521-69.5".',
        },
        year: {
          type: 'number',
          description: 'Optional: a historical year (1999-2025) to fetch that year\'s archived text instead of the current one.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'hi_search',
    description:
      'Search the Hawaii Revised Statutes BY TOPIC or keyword rather than citation — "landlord security deposit", "concealed firearm permit", "murder". Matches against the Legislature\'s own official section and chapter CATCHLINES across the whole Code (not full statutory prose — Hawaii does not publish a full-text search of statute body text, verified live), e.g. "landlord" surfaces sections like "Landlord\'s remedies for failure by tenant to pay rent" under chapter 521 (Residential Landlord-Tenant Code). Returns matching citations and catchlines; call hi_statute with a citation for the full text. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord security deposit".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'hi_statute':
      return hiStatute(args);
    case 'hi_search':
      return hiSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
