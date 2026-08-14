# flat-earth-simulator

Render the world from a point on its surface — on a globe or on a plane — and
compare the result against what a camera actually sees.

The interesting question is not "is the Earth round". It is: at a given place,
lens and eye height, *how much difference does it make*, and is that difference
larger than the uncertainty in your data? For a lot of well-known sightlines the
honest answer is "barely", and a tool worth building has to be able to say so.

## Status

Phases 0-3 of the plan.

| | |
|---|---|
| `src/core` | geodesy, refraction, sightline geometry. Pure TS. |
| `src/build` | scene bundles, sightline analysis, coordinate resolution. |
| `src/app` | three.js renderer, flat/round toggle in the shader. |

146 tests.

## Quick start

```bash
npm install
npm test
npm run build:scene -- scenes/bay-area.json    # writes bundles/bay-area/
npm run sightline    -- bundles/bay-area       # rank every observer/target pair
npm run resolve:scene -- bundles/bay-area --scene scenes/bay-area.json
npm run dev                                    # renderer at localhost:5173
```

`build:scene` writes a terrain grid, buildings, tide constituents and a
manifest recording where every layer came from and what in it is still an
assumption. `sightline` is the one worth running before a ride.

### Where to stand

```
observer            target                    dist     diff  arcmin    px  note
albany-beach        ggb-south-tower       16.38 km    7.9 m    1.65    15
albany-beach        ggb-north-tower       15.91 km    7.2 m    1.56    15
point-isabel        ggb-south-tower       16.49 km    3.5 m    0.73     7
richmond-annex      salesforce-tower      14.20 km    2.3 m    0.55     —  blocked by terrain at 9.38 km
```

The Golden Gate towers dominate — longest baseline, cleanest water path.
Downtown never places. `richmond-annex` is blocked toward San Francisco by
terrain at around 9.4 km, almost certainly Brooks Island; obstructed pairs
score zero rather than merely low, because a blocked sightline is not a weak
curvature test, it is not a curvature test at all.

## The renderer

`npm run dev` after building a scene. Pick an observer and a target, hit *Aim
at target*, and toggle Flat Earth.

Notes on what it does and does not do:

- Geometry is built once in a scene-local frame and the observer is a shader
  uniform, so changing viewpoint or sweeping the radius costs no rebuild.
- Aiming points at the target's apparent elevation, not merely along its
  bearing. At 600 mm the frame is about two degrees tall and the Marin
  headlands sit roughly 1.1 degrees above the horizon, so aiming level puts
  the thing you asked for just outside the top of the picture.
- Drag sensitivity scales with field of view. A fixed rate makes long lenses
  unusable.
- The custom shaders pull in three.js's `logdepthbuf` chunks. Without them the
  logarithmic depth buffer flag costs you the work and gives none of the
  benefit across a scene spanning metres to hundreds of kilometres.
- Normals are computed in the flat frame. Curvature tilts a surface by at most
  the ray angle, about 0.14 degrees over 15 km, which is far below anything
  visible in shading.
- `npm run shots` drives it headlessly through a few observer/lens/model
  combinations and writes PNGs, so a renderer regression is visible without a
  GPU or a human.

## On a phone

The point of the phone is holding the render up against the thing itself. Six
controls in the top bar: tuck the panels away, camera on, split/blend/render,
location, gyro, full screen.

**Choosing a lens.** Device labels are blank until camera permission has been
granted, so the lens menu can only be filled in after a camera has been opened
once. iOS 16.3 and later lists the back lenses individually; before that they
are fused into one device and the telephoto cannot be reached from the web at
all. iOS supports no `zoom` constraint in any browser, because they are all
WKWebView, so picking a lens by name is the only mechanism there is.

**Matching the zoom.** No browser will tell you what angle a camera frame
covers — there is no field of view in `MediaTrackSettings`, no focal length,
and no EXIF on a live track. So the angle is calibrated instead: point the
camera at two landmarks, tap each one, and there is exactly one focal length
that reconciles the pixel offsets with the angular separation the scene already
knows. It is stored per lens and per capture size, because the same lens
delivers different crops at different resolutions. Until then the app guesses
from the lens name and says so.

With the angle known, the video is cropped to whatever the focal slider asks
for. Past the lens's own reach that adds no detail, but both halves of the
screen then mean the same thing, which matters more. Going *wider* than the
lens cannot be faked, so the slider stops at the widest matchable focal length
rather than quietly showing two different angles side by side.

**Standing where you are.** The horizontal fix is used and the altitude is
thrown away. GPS altitude is often absent on Android and carries ten to twenty
metres of error where it exists — several times the four to eight metres of
hidden height the whole exercise is trying to see. Ground elevation comes from
the terrain grid, sampled at the fix; five metres of lateral error moves a
thirteen-kilometre sightline by five metres, which is nothing.

**The gyro is a tracker, not an aim.** Pitch and roll are good to about a
degree. Heading needs the magnetometer and is good to two to five degrees at
best — worse beside a car or a railing — while a 600 mm frame is 3.4 degrees
wide. So drag a landmark into place once and the offset is held from then on,
with the sensor supplying only the motion. iOS needs `requestPermission()` from
inside a tap and reports true north in `webkitCompassHeading`; Chrome for
Android fires `deviceorientationabsolute` against *magnetic* north, so the
scene carries its own `magneticDeclinationDeg`. It can be switched off.

- `npm run phone-check` drives all of it headlessly: Chromium's fake camera
  stands in for a lens, Playwright's geolocation override for a fix, and
  dispatched `DeviceOrientationEvent`s for the sensors. The zoom match is
  asserted numerically — the angle the cropped camera shows against the angle
  the render draws — because a factor of 1.1 between them is invisible and
  ruins the comparison.

## CI does the work you cannot do locally

Two upstreams are unreachable from some development environments —
`extensions.duckdb.org` (needed by DuckDB at runtime) and
`api.tidesandcurrents.noaa.gov`. A GitHub runner has ordinary egress, so CI
runs the strict build, resolves coordinates against Overture, and uploads both
the bundle and the resolved scene as artifacts.

That paid for itself immediately. The first run reported `0 buildings` beside
`Heights: 4258 measured` — the query worked and every row was then dropped by a
geometry decode whose failure a bare `catch { continue }` had swallowed.

## How the flat/round toggle works

There is no globe. Geometry is stored in a local surface frame centred on the
observer — `(east, north)` as geodesic surface offsets, `up` as height above
the scene datum, with no curvature baked in. Curvature is then applied
per-vertex from a single uniform:

```
theta = d * invR
horiz = d*sinc(theta) + h*sin(theta)
up    = h*cos(theta) - d*versOverTheta(theta)
```

`invR = (1 - k) / R`, the inverse effective radius. Flat Earth is `invR = 0`,
and it falls out of the same expression rather than needing a branch. Because
the parameter is continuous you can also sweep it — which turns "compare two
models" into "solve for the radius that best fits this photograph".

Two details that are load-bearing:

- **Inverse radius, not radius.** `R_eff = R/(1-k)` is singular at `k = 1` and
  cannot express ducting at all. `invR` passes smoothly through zero, so a
  round Earth under a strong enough inversion — which renders *identically to a
  flat one*, and is a real observable condition — is just another point on the
  slider.
- **The versine form.** The textbook `(R+h)cos(theta) - R` subtracts two
  numbers of order 7.4e6 to get one of order 11. In the float32 shader that
  leaves ~0.5 m of quantisation on an 11 m answer: 5% error, silently, in
  exactly the quantity being measured. A test pins this down.

## Refraction is an input, not a constant

Every visibility claim depends on `k`, and it is not a fixed number — it is set
by the near-surface temperature gradient, which swings with climate, season and
especially the air-to-water temperature difference. Over sun-heated ground
`k` goes *negative*; under a marine inversion it can exceed 0.3; at `k = 1`
light curves with the surface and sight range is unbounded.

This matters more than it sounds. Long-range photographs used in these
arguments are generally taken in anomalous conditions, so a simulator that
hard-codes `k = 0.13` will disagree with honest photographs and prove nothing.
`k` is a first-class parameter here.

Cold upwelled water under warm inland air makes San Francisco Bay a
particularly unstable refraction environment, which is worth knowing before
trusting any single observation made there.

## Vertical datums

Four sources, four reference surfaces: GPS gives ellipsoidal height, 3DEP gives
NAVD88, Copernicus gives EGM2008, tide gauges give MLLW. Geoid-ellipsoid
separation is about -32 m in the Bay Area and ranges to +/-100 m worldwide, so
mixing two datums is a tens-of-metres error on an effect of a few metres — with
no visible symptom. Heights therefore carry their datum in the type, and
combining mismatched ones throws. Separations come from the scene config with a
cited source, never from a default.

## Bay Area v1

The scene covers 37.75-37.95 N, -122.55 to -122.25 W: the Bay Trail from
Richmond Annex to Emeryville, and everything visible from it.

What the numbers say for this site (k = 0.13, 1.6 m eye height):

- Downtown San Francisco at 12.9 km: **4.43 m** of waterfront hidden. About one
  storey out of a 326 m tower — real, measurable with a tripod and a long lens,
  but not a dramatic image, and inside the error budget of GPS, tide and
  refraction variability.
- Golden Gate towers at 15.7 km: **8.10 m** hidden. Longer baseline and a clean
  over-water path.
- **Critical observer height for downtown: 11.36 m refracted, 13.06 m
  geometric.** Below it the waterline is cut; above it, fully exposed. The flat
  model predicts no such transition at any height.

That last one is the experiment this site is actually good for. The Albany Bulb
has roughly that much accessible relief, so the transition can be walked in ten
minutes with one lens on one afternoon — a differential measurement in which
tide, building-model error and lens calibration all cancel. The ~1.7 m gap
between the two predicted transition heights means the height at which the
waterline reappears *measures* `k`.

## Data sources

| Layer | Source | Licence | Status |
|---|---|---|---|
| Terrain | AWS Terrain Tiles (Terrarium) | mixed PD / CC-BY | working |
| Buildings | Overture Maps `2026-07-22.0` | ODbL / CDLA | written, unexercised |
| Tide | NOAA CO-OPS harmonic constituents | public domain | written, unexercised |

Harmonic constituents are baked rather than predictions, so tide works offline
and does not expire. It is a first-order term: the Bay's diurnal range is
comparable to the whole curvature effect at these distances.

### Known approximations

- **Terrarium carries bathymetry**, so open water arrives as seafloor depth —
  about -20 m mid-bay. Left alone, every over-water sightline would be tested
  against a surface 20 m below the one that actually blocks it. v1 clamps
  sub-zero cells to 0 m (47% of this scene); the real fix is a coastline-derived
  water mask.
- **Terrarium mixes SRTM, NED and GMTED**, whose native vertical datums differ.
  Tagged EGM2008 as the closest single label. Replace with USGS 3DEP before
  treating a render as a measurement.
- **Landmark coordinates in `scenes/bay-area.json` started as guesses.**
  `resolve:scene` now fixes what it can, and records which fixes count as
  verification: an Overture name match is independent confirmation, a DEM
  summit snap is only self-consistency. Targets declare a `kind`
  (`building` / `summit` / `fixed`) and anything undeclared is left alone —
  with summit-snapping as a fallback the resolver cheerfully walked Salesforce
  Tower 1.5 km onto a hill and called it a resolution.
- **The Golden Gate tower coordinates are still hand-typed.** Bridge towers
  are neither Overture buildings nor summits, so nothing can resolve them
  automatically — and they carry the best sightlines on the route.

The build reports all of this rather than burying it:

```
20 unverified assumptions in this bundle:
  - albany-bulb (Albany Bulb): coordinates unverified
  - terrain: bathymetry clamped to 0 m in place of a real water mask (47.4%)
  ...
This bundle can be rendered, but is not a measurement until these are resolved.
```

## Going elsewhere

Nothing outside `scenes/` is Bay Area specific. Providers declare their own
coverage, resolution, datum and licence, so another region means new scene
config and possibly new providers — not edits to the pipeline. The things that
change are 3DEP being US-only (FABDEM or Copernicus GLO-30 globally), NOAA
being US-only (FES2022 via PyFES), declination needing WMM, and the flat model
stopping being locally self-consistent as you move away from the north pole.

## Licence

MIT.
