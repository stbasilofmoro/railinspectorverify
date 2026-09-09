# RailInspectorVerify — design

**Date:** 2026-09-09
**Status:** Approved, implemented

## Problem

Tie Disposal needs to tell a prospective customer, from an address alone,
whether their property is served by a railroad and whether that railroad
requires an independent crosstie inspection before ties are removed.

## The core difficulty

The naive reading — "is there track near this address?" — is the wrong
question and would produce confidently wrong answers. In any industrial
corridor, almost every address has track within a few hundred metres. What
matters is whether an **industrial lead, spur, or siding actually reaches the
parcel**, because that is what makes a facility rail-served and gives a
particular railroad the relationship in question.

OpenStreetMap alone cannot reliably answer this. Its `operator` tags are
uneven on industrial trackage, and `service=spur|siding` is inconsistently
applied.

The FRA National Rail Network solves it. Its `NET` field classifies every
segment, and two of its codes mean precisely "industrial track that serves a
facility":

- `I` — Major Industrial Lead
- `O` — Other track (minor industrial leads)

versus `M` (mainline), `S` (passing siding), `Y` (yard), and `A`/`R`/`X`/`T`/`Z`
(abandoned, removed, out of service, trail, transit-museum).

**Decision:** FRA is the primary source for both ownership and track class.
OSM is a secondary source, used to corroborate the operator and to catch spurs
FRA has not recorded.

## Architecture

Static single-page app. No backend, no build step, no API keys.

All four upstream services are public and send permissive CORS headers, which
was verified before committing to this shape:

| Service | Role | CORS |
|---|---|---|
| Nominatim | Primary geocoder | ✅ |
| Photon | Fallback geocoder | ✅ |
| FRA NARN (ArcGIS) | Ownership + track class | ✅ `*` |
| Overpass | OSM operator/spur tags | ✅ |

**Rejected:** the US Census geocoder. It is free, keyless, and excellent for US
street addresses, but it sends **no CORS headers**, so a static browser page
cannot call it. This was the deciding constraint on the fallback chain.

### Distance calculation

FRA and Overpass both return line geometry. Distances are computed client-side
as point-to-polyline in a local planar approximation (equirectangular, scaled by
`cos(lat)`). At a 400 m radius the projection error is negligible, and this
avoids both a geodesy dependency and reliance on the ArcGIS `distance`
parameter, which returned empty results in testing where an envelope query
succeeded.

### Classification

```
nearest industrial track ≤ SERVED_M (200 m)  → rail-served
nearest industrial track ≤ SEARCH_M (400 m)  → possibly rail-served (flagged)
active track present, none industrial        → not rail-served, railroad named
nothing within SEARCH_M                      → no rail service
```

`SERVED_M` was raised from an initial 120 m after testing against a known
rail-served industrial property (1400 W 35th St, Chicago), where FRA showed two
Norfolk Southern `NET=O` segments between 120 m and 400 m of the geocoded point
and nothing inside 120 m. Geocoders return a *building centroid*; industrial
parcels are routinely 200 m or more across. A 120 m radius would have reported
that property as not rail-served.

A residential control address in Naperville returned no track within 400 m, as
expected.

### Operator resolution

The owner of the **nearest industrial track** is the serving railroad — that is
the carrier that would actually deliver cars. Where the nearest industrial
segment has no recorded owner, the nearest segment that does have one is used.

Passenger and transit operators (`AMTK`, `METX`, and similar) are recognised and
skipped rather than reported as a freight verdict, falling through to the
segment's freight owner or trackage-rights holder.

## Policy table

All inspection claims live in `assets/railroads.js` and nowhere else, so a
policy change is a one-line edit.

| Verdict | Aspect | Carriers |
|---|---|---|
| `required` | STOP | CSX, Union Pacific, BNSF, CPKC |
| `not_required` | CLEAR | Norfolk Southern (flagged), CN |
| `unclear` | APPROACH | everything else |

Subsidiary and predecessor reporting marks are enumerated per carrier because
FRA records frequently carry the historical owner — `IC` segments are CN track,
`SP` and `CNW` segments are Union Pacific track, `ATSF` is BNSF.

Norfolk Southern carries a `reviewNote` rather than a guessed policy. The
announced UP–NS merger may move it to `required`; the UI surfaces the
uncertainty instead of resolving it silently.

**Short lines return APPROACH as a genuine answer, not a failure.** Short-line
tie-disposal policy is real, uneven, and not centrally published. A confident
wrong answer costs a shipper more than an honest handoff.

## Visual design

Documented in `docs/STYLE-GUIDE.html`.

The brief asked for Framer's glowing-edge aesthetic with more gradient and
fluidity. Rather than applying glow decoratively, the design grounds it in the
subject: **wayside railroad signals are literally glowing coloured lamps**, and
their aspects already encode this tool's exact logic. Verdicts are therefore
rendered as signal heads — STOP, CLEAR, APPROACH, and an unlit DARK.

Semantic colour (red/amber/green) is reserved strictly for verdicts. The
violet–cyan–magenta aurora is brand chrome and never carries meaning.

The page commits to a single dark theme. Glow is the whole visual argument and
needs darkness to read; a light variant would be a different product.

## Raffle entry

Web3Forms, posting from the browser to `basil@tiedisposal.com`. The access key
is publishable by design and ships in client-side HTML.

FormSubmit was evaluated first. `formsubmit.io` is defunct; `formsubmit.co` is a
separate service and still operating, but is donation-supported and
single-operator. Web3Forms was chosen for durability. No genuinely open-source
handler was viable, since those require a server, which conflicts with free
static hosting.

The form appears only **after** a lookup completes, per the brief.

## Known limitations

- US only.
- Screening tool, not an authority — FRA data can lag the ground truth.
- Nominatim rate-limits to ~1 req/s; unsuitable for bulk lookups.
- Web3Forms rejects server-side submissions, so the form cannot be verified
  by any non-browser test.
