# The Greenlight Claim Protocol and Pre-flight API

Specification v0.1 (draft), 2026-10-16. Author: Tree, for Rene Turcios / CloudCorpRecords.
Status: design. Phase 1 is scoped at the end and ready to build.

## 1. The problem, from field data

GitHub has no claim system. When a contributor wants to work on an issue, the only
signal available is a comment, and comments fail in every direction:

- **Races are invisible.** In our Wave 3 vetting (2026-10-15), 5 of 12 researched
  claims were already dead: a pull request fixing the issue existed, recorded only
  as a `cross-referenced` event in the issue timeline, a place almost nobody reads.
  Each dead claim cost hours of research and building.
- **Claims rot.** Claim comments sit for weeks or months with no expiry. We found a
  two month old soft claim on actualbudget #6643 that may or may not still be real.
  Nobody, contributor or maintainer, can tell a live claim from an abandoned one.
- **Arbitration is manual.** When two people do claim or PR the same issue, the
  maintainer has to read every comment and timeline event to work out who was
  first. Composio issue #4668 had two open PRs racing; firecrawl #839 had claims
  from 2025 still notionally blocking work in 2026.
- **Agents make all of this worse.** AI coding agents open PRs without reading
  comments at all. Maintainer response, already visible in the wild: activepieces
  auto-closes every external PR within about a minute. The wall is going up
  because coordination has no machine-readable form.

## 2. What the protocol is

A claim format and lifecycle that live natively on GitHub, plus a public index
(the Ledger) and a pre-flight API that answers one question in one call:

> "Can I work on this issue, right now, and what will happen if I do?"

Three design commitments:

1. **GitHub is the source of truth, the Ledger is only an index.** A claim is a
   GitHub comment with a machine-readable marker. Anyone can rebuild the full
   Ledger by reading public comments. No lock-in, no single point of failure,
   and GitHub's own timestamps (which nobody can forge) order everything.
2. **Claims are leases, not property.** Every claim expires unless renewed.
   Expiry is computed by any reader from public data, not granted by a server.
3. **Maintainer sovereignty.** A repo's own policy file overrides every protocol
   default, and a maintainer can release or reassign any claim on their repo at
   any time. The protocol proposes; the maintainer disposes.

## 3. The claim

### 3.1 Format

A claim is a comment on the issue containing this marker on its own line:

```
<!-- greenlight-claim v1 -->
```

with human-readable text around it. The recommended shape (what
`greenlight claim` posts from Phase 1):

> I would like to work on this. Plan: reproduce the failure first, then fix and
> add a regression test. Expected: 3 days.
>
> <!-- greenlight-claim v1 -->
> Claimed under the Greenlight Claim Protocol: this claim renews or expires
> automatically, and releases the moment a PR is linked or I say so.

Optional structured lines after the marker: `plan:`, `eta-days:`, `queue-ok: yes`.
Parsers must ignore unknown lines. The marker alone is sufficient to be a valid
claim; everything else is advisory.

### 3.2 The claim record (what the Ledger stores and the API returns)

```json
{
  "v": 1,
  "repo": "ComposioHQ/composio",
  "issue": 4668,
  "claimant": "someuser",
  "claimed_at": "2026-10-16T17:02:11Z",
  "comment_url": "https://github.com/ComposioHQ/composio/issues/4668#issuecomment-...",
  "state": "active",
  "lease_days": 7,
  "expires_at": "2026-10-23T17:02:11Z",
  "last_heartbeat_at": "2026-10-16T17:02:11Z",
  "linked_pr": null,
  "queue_position": 1,
  "history": [ { "event": "claimed", "at": "...", "by": "someuser" } ]
}
```

`claimed_at` is the GitHub comment's `created_at`. Ordering of competing claims
is by `claimed_at`, ties broken by comment id. The Ledger never invents a
timestamp of its own for ordering.

### 3.3 Lifecycle

States: `active`, `linked`, `completed`, `released`, `expired`, `superseded`.

- **Claim.** First valid claim on an issue becomes active. Later claims are not
  rejected: they join a public **queue** (position 2, 3, ...), so nobody needs
  to race or guess. A queued claim auto-promotes when the claim ahead of it ends.
- **Heartbeat.** The claimant renews by either (a) posting any comment on the
  issue, or (b) adding a rocket reaction to their own claim comment (reactions
  are API-visible and noise-free; the reactor login must match the claimant).
  A heartbeat extends `expires_at` to heartbeat time plus the lease.
- **Lease and tenure cap.** Default lease 7 days (repo policy may set 1 to 30).
  Total tenure without a linked PR is capped at 28 days; after that the claim
  expires no matter how many heartbeats, unless a maintainer extends it.
  Rationale: a month is long enough for any issue; past that the queue deserves
  its turn.
- **Link.** When a PR with closing intent references the issue, the claim moves
  to `linked` and the lease freezes. Review timelines belong to maintainers;
  a claimant must never lose a claim because review was slow.
- **Complete.** The linked PR merges: `completed`. This event is the raw material
  of future reputation (the passport): claims honored, claims abandoned.
- **Release.** The claimant gives up the claim (a comment containing the release
  marker `<!-- greenlight-claim release -->`, or an API call in Phase 3). The
  next queued claim promotes immediately.
- **Expire.** No heartbeat inside the lease: `expired`, computed lazily by any
  reader and materialized by the Ledger indexer. The issue returns to the pool.
- **Supersede.** A maintainer releases or reassigns a claim: recorded in history
  with the maintainer's login. Always allowed, always public.

### 3.4 Anti-gaming

- One active claim per issue per person, and the queue is visible, so there is
  nothing to win by racing.
- The Ledger caps indexed active claims at **5 per account** across all repos;
  claims past the cap are marked `over-cap` and readers treat them as soft.
  Squatting has a budget.
- Every state change is a public GitHub artifact (comment, reaction, PR link,
  or a maintainer action). Nothing happens off the record.
- A claim from an account whose comment is later deleted simply disappears from
  the index at the next rebuild. Deletion is an implicit release.

## 4. Repo adoption: the policy file

A repo opts in by adding `.greenlight/claims.json`:

```json
{
  "protocol": 1,
  "lease_days": 10,
  "tenure_cap_days": 28,
  "queue": true,
  "who_can_claim": "anyone",
  "maintainers": ["lead-dev-login"]
}
```

- No policy file: protocol claims still work as strong public signals (they are
  just well-formed comments), and Greenlight tools read them, but the repo has
  not promised to honor the queue.
- Policy file present: the repo is listed as **protocol-honoring** in the Ledger
  and on the Friction Index, which is itself an adoption incentive: honoring
  repos visibly attract contributors whose agents check first.
- `who_can_claim` may later accept `passport` (only identities with a track
  record) once the passport exists. The field is reserved now so the policy
  format never has to break.

## 5. The pre-flight API

One call before any work. Read endpoints are public, cacheable, and honest
about freshness.

### 5.1 Issue status

```
GET /v1/issues/{owner}/{repo}/{number}/status
```

```json
{
  "issue": "https://github.com/ComposioHQ/composio/issues/4668",
  "verdict": "TAKEN",
  "claim": {
    "state": "active",
    "claimant": "someuser",
    "claimed_at": "2026-10-16T17:02:11Z",
    "expires_at": "2026-10-23T17:02:11Z",
    "queue": [ { "claimant": "nextuser", "position": 2 } ]
  },
  "competing_prs": [ { "number": 4669, "author": "omlahore", "state": "open" } ],
  "gates": [ { "kind": "changeset_required", "detected": true } ],
  "repo_protocol": { "honored": true, "lease_days": 10 },
  "checked_at": "2026-10-16T18:00:00Z",
  "stale_after_seconds": 21600
}
```

The verdict vocabulary is the one Greenlight already ships:
GO, RISKY, TAKEN, GATED, STALE. An active protocol claim maps to TAKEN with the
expiry date in the reason, an expired one to GO with a note, a live race to
TAKEN naming the PRs. Agents already consuming Greenlight verdicts need no new
logic; the protocol simply makes the verdicts exact.

### 5.2 Repo friction and policy

```
GET /v1/repos/{owner}/{repo}/friction
```
Score, class, outside merge share, median merge time, gate list, and the repo's
claim policy if it has opted in. This is the Friction Index as an API.

### 5.3 Claim chain

```
GET /v1/claims/{owner}/{repo}/{number}
```
The full append-only history of claims on one issue: every claim, heartbeat,
link, release, and expiry, with the public evidence URL for each event.

### 5.4 Writes (Phase 3)

```
POST /v1/claims            (GitHub OAuth)  -> verifies state, records intent,
                                               returns the exact comment to post
POST /v1/claims/{id}/release
POST /v1/claims/{id}/heartbeat
```
Writes stay conservative: in Phases 1 and 2, claiming happens by posting the
comment with your own GitHub identity (CLI or by hand), and the Ledger indexes
it. The API never posts as you without an OAuth grant scoped to the purpose.

### 5.5 How the API is served

- **Phase 2 form: a static API.** The Ledger is a public git repository
  (`CloudCorpRecords/claim-ledger`). An indexer Action rebuilds it on a schedule
  from public GitHub data, and publishes per-repo and per-issue JSON files to
  GitHub Pages. The URLs above map to static files. Zero servers, zero cost,
  fully inspectable, and every response carries `checked_at` so staleness is a
  fact, not a surprise. Freshness target: 15 minutes for opted-in repos.
- **Phase 3 form: a hosted API** (edge workers) when freshness or write volume
  demands it, reading the same Ledger format. The format is the standard; the
  hosting is replaceable.

### 5.6 MCP surface

Agents should never have to hand-roll HTTP for this. Greenlight's MCP server
gains two tools, so every agent using the drop-in pack speaks the protocol
natively:

- `claim_status` -> the 5.1 payload for an issue URL.
- `preflight` -> issue status plus repo friction in one call, the "should I
  start" answer.

`claim_issue` upgrades to posting protocol-format claims (marker, plan, ETA),
and `check_issue` treats protocol state as first-class evidence.

## 6. How the existing products plug in

- **check_issue**: protocol claim state sharpens TAKEN from "someone said
  something in a comment" to "active lease held by @x until DATE, queue is
  [@y]". Expired claims stop scaring contributors away from free issues.
- **guard**: a PR opened against an active protocol claim held by someone else
  is the highest-confidence flag the guard can raise, and the guard Action can
  point the author at the queue instead of just saying no.
- **digest**: expired claims, queue depth, and claims nearing the tenure cap
  become digest sections; maintainers get claim lifecycle management without
  reading comments.
- **Friction Index**: protocol-honoring repos get a visible badge and, over
  time, a measurable claim-health stat (median claim age, expiry rate), which
  is data no one else publishes.
- **The passport (later)**: completed vs abandoned claims per identity is the
  fairest reputation signal in open source, because it measures follow-through,
  not popularity.

## 7. Build phases

**Phase 1: the protocol in the client (Greenlight v0.4.0).** No servers.
- Protocol parser in claims.ts: marker detection, lease and tenure math, queue
  construction from an issue's comments, state computation as a pure function.
- Policy file reader (`.greenlight/claims.json`) with the repo's overrides.
- `check_issue` and `guard` consume protocol state; `claim_issue` posts the
  protocol format; new `claim_status` and `preflight` MCP tools.
- Our own campaign dogfoods it from day one: every claim we post uses the
  marker, on real repos, immediately.
- Fixtures for every lifecycle transition, including queue promotion and the
  tenure cap. Tests stay the contract.

**Phase 2: the Ledger and the static API.**
- `CloudCorpRecords/claim-ledger` repo, indexer Action (search opted-in repos
  plus any repo where protocol comments appear), JSON published to Pages.
- A claims board page on the Friction Index site: live claims, queues, and
  expiries across seeded repos.
- Seed list: our campaign repos first (we have standing there), then the 43
  Friction Index repos get policy detection (not indexing spam: only repos with
  protocol comments or a policy file are indexed).

**Phase 3: hosted API, writes, enforcement.**
- OAuth writes (claim, release, heartbeat endpoints), hosted freshness.
- Guard Action enforcement options for honoring repos: auto-label a PR that
  violates an active claim, with the claim evidence attached.
- Maintainer outreach: the digest and the Friction Index are the pitch; the
  protocol is the close.

## 8. Risks and open questions, stated plainly

- **Cold start.** A protocol nobody uses is a comment format. Mitigations: our
  own campaign runs on it visibly, the guard and digest give maintainers a
  reason to honor it before contributors arrive, and the Friction Index badge
  makes honoring public. Still the top risk.
- **GitHub ships native claims.** Then the Ledger becomes an export and history
  layer and Greenlight becomes the best client for the native system. The work
  is not wasted, but the moat narrows. Speed matters.
- **Indexer cost.** Search and timeline APIs are rate limited. Mitigation:
  index opted-in and active repos only, cache aggressively, and let any repo
  maintainer trigger a refresh. Webhooks are the Phase 3 answer.
- **Comment noise.** One claim comment per person per issue, heartbeats via
  reactions by default. The protocol is designed to reduce comment archaeology,
  not add to it.
- **Gaming the queue.** Queue positions are public and cheap to take. The
  5-claim cap and the tenure cap bound the damage; maintainers remain sovereign.

## 9. What success looks like

Ninety days after Phase 2: an agent that checks before it works gets an exact
answer for every seeded repo; our own claims run on the protocol in public; a
first maintainer we do not know honors a queue because the guard surfaced it;
and the Friction Index shows claim health next to friction. That is the point
where the protocol stops being ours and starts being infrastructure.
