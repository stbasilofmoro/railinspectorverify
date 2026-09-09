# RailInspectorVerify

Check whether a property address is served by a railroad, identify which railroad
it is, and find out whether that railroad requires an **independent crosstie
inspection** before ties can be removed.

Live site: **https://stbasilofmoro.github.io/railinspectorverify/**

---

## The question it actually answers

"Is there rail near this address?" and "is this address rail-served?" are
different questions, and only the second one matters for tie disposal. A Class I
mainline running past the fence line does not make a property rail-served — an
**industrial lead, spur, or siding reaching the parcel** does.

The FRA National Rail Network encodes exactly this distinction in its `NET`
field, which is why this tool leans on it rather than on raw proximity to track:

| `NET` | Meaning | Treated as |
|-------|---------|------------|
| `I` | Major industrial lead | **Rail service** |
| `O` | Other track / minor industrial lead | **Rail service** |
| `M` | Mainline | Not service on its own |
| `S` | Passing siding (over 4000 ft) | Not service on its own |
| `Y` | Yard track | Not service on its own |
| `A` `R` `X` `T` `Z` | Abandoned, removed, out of service, trail, transit/museum | Ignored |

## The four answers

Verdicts are presented as wayside signal aspects, because that is what they are.

| Aspect | Meaning | Railroads |
|--------|---------|-----------|
| 🔴 **STOP** | Independent inspection required | CSX, Union Pacific, BNSF, CPKC |
| 🟢 **CLEAR** | Railroad accepts its own inspection | Norfolk Southern\*, CN |
| 🟡 **APPROACH** | Short line — confirm with the railroad | 600+ carriers |
| ⚫ **DARK** | No industrial track reaches the address | — |

\* Norfolk Southern is flagged **policy under review**: the announced Union
Pacific merger may move it to the inspection-required list. The tool says so on
every NS result rather than assuming an outcome.

## Changing a railroad's policy

Everything the app claims about inspection requirements lives in one file:
[`assets/railroads.js`](assets/railroads.js). Nothing is hard-coded elsewhere.

To move a railroad between verdicts, change its `policy` value:

```js
{
  id: 'ns',
  name: 'Norfolk Southern Railway',
  policy: POLICY.NOT_REQUIRED,   // <- change to POLICY.REQUIRED
  reviewNote: 'Policy under review pending the Union Pacific merger.',
  marks: ['NS', 'NW', 'SOU', ...],
}
```

Commit and push; GitHub Pages redeploys automatically. Subsidiary and
predecessor reporting marks are listed under `marks` because FRA track records
frequently still carry the historical owner (an `IC` segment is CN track, a
`SP` segment is Union Pacific track).

## How it works

No backend, no API keys, no build step — a static page calling four public
CORS-enabled services directly from the browser.

```
address
   │
   ├─ 1. Geocode ──── Nominatim ──(on failure)──► Photon
   │                  Both keyless. The US Census geocoder was evaluated and
   │                  rejected: it sends no CORS headers, so a static page
   │                  cannot call it.
   │
   ├─ 2. Track ────┬─ FRA National Rail Network (ArcGIS)  → ownership + NET class
   │               └─ OpenStreetMap via Overpass           → operator + spur tags
   │                  Distances computed client-side from returned geometry.
   │
   ├─ 3. Classify ─── nearest industrial track ≤ 200 m → rail-served
   │                  ≤ 400 m → possibly rail-served, flagged for verification
   │                  otherwise → not rail-served
   │
   └─ 4. Policy ───── reporting mark → carrier → verdict (assets/railroads.js)
```

### Tuning

Both thresholds sit at the top of [`assets/app.js`](assets/app.js):

```js
var SERVED_M = 200;   // industrial track this close => rail-served
var SEARCH_M = 400;   // outer search radius
```

`SERVED_M` is set to 200 m deliberately. Geocoders return a *building centroid*,
and industrial parcels are frequently 200 m or more across, so a tighter radius
misses spurs that genuinely serve the property. Raising it increases false
positives on dense industrial corridors; lowering it misses real customers.

## Raffle entries

The entry form posts to [Web3Forms](https://web3forms.com), which emails each
submission to `basil@tiedisposal.com`. The access key in `assets/app.js` is a
*publishable* key — Web3Forms is designed for it to ship in client-side HTML,
and it only accepts submissions originating from a browser.

To change the destination address, generate a new key at web3forms.com and
replace `WEB3FORMS_KEY` in `assets/app.js`.

## Design

The visual system is documented in [`docs/STYLE-GUIDE.html`](docs/STYLE-GUIDE.html)
— open it in a browser. The design rationale and architecture decisions are in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

## Limitations

- **United States only.** FRA coverage includes Canada and Mexico, but the
  geocoding is US-biased and the policy table is US carriers.
- **Screening tool, not authority.** Track data can lag real-world changes, and
  a spur shown in FRA data may be out of service on the ground. Confirm with the
  railroad before acting on any result.
- **Short-line coverage is uneven.** This is why APPROACH exists as a real
  answer rather than a fallback — a confident wrong answer costs more than an
  honest handoff.
- **Nominatim rate-limits** to roughly one request per second. Fine for
  interactive use; not suitable for bulk lookups.

## Data sources and licence

- [FRA North American Rail Network Lines](https://catalog.data.gov/dataset/north-american-rail-network-lines3)
  — USDOT / Bureau of Transportation Statistics, National Transportation Atlas Database
- [OpenStreetMap](https://www.openstreetmap.org/copyright) — © OpenStreetMap
  contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)
- Geocoding by [Nominatim](https://nominatim.org) and [Photon](https://photon.komoot.io)
