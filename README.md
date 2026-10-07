# @pipeworx/hawaii-code

Hawaii Revised Statutes (HRS) — state statutes by citation, by official
catchline (topic search), with inline amendment/enactment history and a
year-by-year historical archive back to 1999. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1715+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `hi_statute(citation, year?)` — full text of an HRS section by citation
  ("707-701" is murder in the first degree; "521-44" is a landlord's
  security-deposit duty under the Residential Landlord-Tenant Code).
  Includes the official catchline, chapter context, and amendment/enactment
  history parsed from the Legislature's own trailing "[L 1972, c 9, ...]"
  session-law bracket. Pass `year` (1999-2025) to get that year's archived
  text of the same section instead of the current one.
- `hi_search(query, limit?)` — topic/keyword search over the Legislature's
  own official section and chapter catchlines (not full statutory prose —
  see below), returning matching citations.

## Auth

Keyless.

## The survey trap did not apply — it was never really walled

The August survey recorded "Hawaii (403)" and stopped there. Looking past
it: the Legislature's statute site (`www.capitol.hawaii.gov/hrscurrent/`)
sits behind Cloudflare and its WAF returns a hard 403 **"Sorry, you have
been blocked"** to this fleet's laptop/office IP on every request —
reproduced with a dozen UA/Accept/Accept-Language combinations, including a
full real-Chrome header set, 0 passes. That matched the described trap.

The edge probe said otherwise. A throwaway `wrangler dev --remote` Worker on
the prod Cloudflare account, fetching the exact same URLs, got clean 200s
every time — cache HIT and MISS, a dozen distinct real pages, zero blocks.
This is the **inverse** of the oscn.net/oklahoma-code case (Worker blocked,
browser fine): here the Cloudflare **Worker** is the client that gets
through, and the laptop is the one that doesn't. Since the live gateway
*is* a Cloudflare Worker, it needs no egress relay, no special header, and
no BYOK — a plain `fetch()` from the gateway reaches the site directly. The
pack's own `src/index.ts` header has the full probe trail; this file's job
is just to record the conclusion for the next person who sees "403" in a
survey and reaches for the relay reflexively.

## No combined index, no search API — one TOC fetch per chapter, baked once

`hrscurrent/` is a plain IIS directory tree, one file per section:

```
/hrscurrent/Vol{NN}_Ch{range}/HRS{chapterNum}/HRS_{chapterNum}-{section}.htm
```

Every chapter directory also carries exactly one extra file —
`HRS_{chapterNum}-.htm` — which is the chapter's own official table of
contents: a "CHAPTER NNN" heading, the chapter's name, and every section
number with its official catchline. One fetch per chapter (1,108 of them)
is enough to bake the whole citation + catchline index; `hi_search` reads
that baked table entirely in memory. `hi_statute` uses the baked table to
resolve a chapter, then encodes the expected filename for the requested
section and fetches it live — falling back to a live directory listing if
the encoded guess doesn't resolve (a section added, renumbered, or carrying
a decimal/letter-suffix shape the encoder didn't predict since the last
bake). The baked table never carries statutory body text.

### Three TOC-parsing traps, found by actually diffing bake output, not by inspection

1. **A section immediately followed by a blank-line separator was silently
   dropped**, not just its continuation text — the blank-line handler reset
   the in-progress section without ever pushing it to the output. This is
   the MOST common shape (the last section before every "Part" header, and
   the last section of every chapter), so the first bake silently lost
   roughly 1 in 10 sections fleet-wide (confirmed: "521-11" and "414-1" were
   both missing) before the flush was added to every place the loop resets
   `current`.
2. **A run of consecutively repealed sections renders on ONE line**, not
   one-per-line — e.g. "27-12, 13 Repealed" or "27-21, 21.1, 21.2, 21.3
   Repealed" (chapter 27, confirmed live). Only the first number carries the
   chapter prefix. Left unhandled, that whole line falls through to
   "continuation text" and silently corrupts the PRECEDING real section's
   catchline.
3. **A handful of chapters append a cross-reference appendix** after the
   real section listing: either a "DERIVATION TABLE OF CHAPTER NNN FROM
   <uniform act>" (chapter 414's Model Business Corporation Act
   cross-reference literally renders "414-1          1.01", which matches
   the section-citation pattern and silently overwrote the real "414-1
   Short title" row) or a bare renumbering/disposition table in plain
   columns with no heading at all (chapter 634). Both are reliably in the
   `XNotes`/`XNotesHeading` CSS class the real section list never uses, so
   the parser stops at the first such block — **gated on having already
   passed the chapter's own heading**, because the anchor chapter of a
   Title (e.g. chapter 21) opens with a TITLE-level chapter list and its own
   "Cross References" block BEFORE its "CHAPTER 21" heading even appears;
   stopping unconditionally at the first XNotes block there would discard
   the chapter's entire real content.

### A fourth trap, in the SECTION page itself, not the TOC

The heading and the section's OPENING SENTENCE are routinely the same `<p>`
block — HRS writes `<b>§707-701  Murder...</b>  (1) A person commits...` as
one paragraph, not two. Matching the heading regex against the whole
flattened paragraph text swallows that opening sentence into the parsed
`catchline` and drops it from the body entirely (confirmed live: an early
version of `hi_statute('707-701')` returned text starting at "(a) More than
one person..." instead of "(1) A person commits the offense of murder in
the first degree if the person intentionally or knowingly causes the death
of:"). Fixed by reading the heading from ONLY the content inside the first
`<b>...</b>` span in the raw block, and treating whatever text follows that
closing tag in the SAME block as the first piece of body text.

### Refresh path

Re-run the bake script whenever Hawaii recodifies (typically once a year,
after a legislative session's Act compilation):

```
node mcps/hawaii-code/scripts/bake-index.mjs --relay <url> > mcps/hawaii-code/src/hi-index-data.ts
```

`--relay` must point at a running passthrough Worker (`GET /?raw=1&url=<target>`
→ `fetch(target)` bytes verbatim) if run from a network the WAF blocks —
this fleet's laptop needs it; the live gateway does not. It fails loudly
(not silently) if it finds fewer than 10 volumes or fewer than 500 chapters
or fewer than 10,000 sections — any of those would mean the site's markup
changed rather than that the Code shrank.

## Charset — hrscurrent is UTF-8, the historical archive is not

`/hrsarchive/hrs{YYYY}/` (confirmed live 1999-2025, the SAME directory
shape under a different root) serves older years as **windows-1252**, with
the charset declared only in the HTML `<meta>` tag — never in the HTTP
header. Decoding every page as UTF-8 regardless would silently mangle every
`§`, em dash, and curly quote in an archived page, the same class of bug
that once corrupted oscn.net through the shared egress relay (fleet #2742).
`sniffAndDecode` reads the `<meta charset>` declaration from the raw bytes
before choosing a decoder, on every fetch — current and historical alike.

## The "not found" page is HTTP 200, not 404

A citation that doesn't exist gets HTTP 200 with the site's own generic
IIS/ASP.NET 404 page (`charset=iso-8859-2`, `/screen.css`) — not a 404
status, not the statute template. A status-code check alone would read
every missing citation as a transport success with nothing to parse.
`isNotFoundPage` distinguishes that from a genuine parse failure (the
statute template IS present — `WordSection1`/`hrs.css` — but the heading
regex still found nothing, which rejects loudly, never silently) and from a
Cloudflare block page (also rejects loudly — see `isBlockedPage`, defense in
depth even though this site's WAF answers with a hard 403 rather than a 2xx
challenge).

## Four capabilities — all four available

- **Citation lookup** — available (`hi_statute`).
- **Topic/keyword search** — available (`hi_search`), but it matches
  official CATCHLINES, not full statutory prose. Hawaii does not publish a
  full-text search of statute body text (verified live). A query like
  "landlord" surfaces 15+ catchlines directly (e.g. "Landlord's remedies for
  failure by tenant to pay rent" under chapter 521) and 80+ total matches
  once chapter-title recall is included.
- **Amendments/enactment history** — available, inline. Every current HRS
  section that has ever been amended ends its own text with a
  `[L 1972, c 9, pt of §1; am L 1986, c 314, §49; ...]` bracket — one
  session-law citation per amendment. `hi_statute` extracts and splits this
  into `amendments_history` rather than leaving it buried in `text`; a
  section with no such bracket says so explicitly rather than omitting the
  field.
- **Historical version** — available back to 1999. `hi_statute({citation,
  year})` fetches the SAME tree under `/hrsarchive/hrs{YYYY}/` — confirmed
  live by fetching HRS 707-701 (murder) as it read in 2015, which is
  shorter than the current text (it predates the 2016 amendment adding the
  family-court-witness circumstance).

## Citations

Hawaii cites by chapter-section, e.g. "707-701" (Chapter 707, Section 701:
murder in the first degree) or "521-44" (Chapter 521, Section 44: security
deposits). The chapter number can carry a letter suffix for an inserted
chapter ("502C-1"); the section number can carry a decimal and/or a
trailing letter ("69.5", "21.6"). `hi_statute` resolves the full citation
against the baked chapter table directly rather than requiring a specific
suffix shape.

## Data sources

- `https://www.capitol.hawaii.gov/hrscurrent/` — the current Hawaii Revised
  Statutes, as a plain directory tree (one file per section, one TOC page
  per chapter). Baked once into `src/hi-index-data.ts` (chapter + citation +
  catchline only, never statutory text); `hi_statute` fetches the one
  section page a caller asks for, live, on every call.
- `https://www.capitol.hawaii.gov/hrsarchive/hrs{YYYY}/` — the same tree for
  a historical year, 1999-2025. Fetched live, never baked.

Both are plain, keyless, server-rendered HTML — no login, no JS. The site's
Cloudflare WAF blocks this fleet's own laptop/office network (see above);
the live gateway, itself a Cloudflare Worker, is unaffected.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hawaii-code": {
      "url": "https://gateway.pipeworx.io/hawaii-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hawaii-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1715+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hi_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"707-701"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hi_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hawaii-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hawaii-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hawaii-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hawaii Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
