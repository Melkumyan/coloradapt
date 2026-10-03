# Color Vision Simulation (M2)

This document describes what ColorAdapt's vision engine (`src/core/vision`)
computes, which published models it uses, where it deliberately
approximates, and how the results were checked.

## What is simulated

The engine answers one question:

> How is a given color (or pair of colors) transformed under a selected
> color vision deficiency (CVD) **model**?

It is a _simulation_ using _models_. It is **not** a medical tool, does not
diagnose anything, and is not an exact reproduction of what any person
sees — color vision varies between individuals even within one named
category. Outputs should be read as _estimated distinguishability_.

The engine only computes information. It never recolors a page (that is M3).

## Pipeline

```
sRGB (gamma-encoded, 0-1)
  -> srgbToLinear            IEC 61966-2-1 piecewise transfer function
  -> linear RGB
  -> CVD model               3x3 / piecewise-3x3 transform, unclamped
  -> linear RGB (may leave the gamut)
  -> clip per channel to [0, 1]   (the explicit gamut policy)
  -> linearToSrgb
  -> sRGB
```

Scientific 3x3 transforms are only ever applied to **linear** RGB. A
`pow(2.2)` approximation is not used. `srgbToLinear` / `linearToSrgb`
(`core/color/srgb.ts`) are tested at 0, the linear-segment threshold, 0.5,
1, and by round trip.

Alpha is passed through untouched. The returned color has no `source`
string, because it no longer corresponds to the original CSS text.

## Models and default policy

| Profile       | Default model                                       | Standing                     |
| ------------- | --------------------------------------------------- | ---------------------------- |
| protanopia    | Brettel, Viénot & Mollon 1997                       | published model              |
| deuteranopia  | Brettel, Viénot & Mollon 1997                       | published model              |
| tritanopia    | Brettel, Viénot & Mollon 1997                       | published model              |
| protanomaly   | Machado, Oliveira & Fernandes 2009                  | published model              |
| deuteranomaly | Machado, Oliveira & Fernandes 2009                  | published model              |
| tritanomaly   | Brettel 1997 dichromacy, linearly interpolated      | **documented approximation** |
| achromatopsia | Relative-luminance gray                             | **documented approximation** |
| normal        | identity                                            | —                            |
| custom        | identity (unsupported — no custom physiology model) | explicitly not simulated     |

`createVisionSimulator(overrides)` accepts a different model per profile;
assignments a model cannot support (e.g. Viénot 1999 for tritan) throw at
construction. Every result carries its `VisionModel` id, and
`VISION_MODEL_INFO[model].fidelity` says whether it is `published`,
`approximation`, or `none`.

### Brettel, Viénot & Mollon 1997 (dichromacy)

A dichromat's colors lie on a surface in LMS cone space made of **two
half-planes** that both contain the neutral axis and one spectral anchor
each (475 nm / 575 nm for protan and deutan, 485 nm / 660 nm for tritan).
A color is projected along the missing cone's axis onto the half-plane on
its side of the _separation plane_ (neutral axis + missing-cone axis). This
is **not** one 3x3 matrix; `deriveBrettelParams` builds both planes and the
separation normal explicitly, and `brettelDichromacy` selects the plane per
color. Tests assert both planes are really used for every family.

Deliberate deviation from the paper: the neutral axis is the display white
(R=G=B), not the equal-energy stimulus E, as in Viénot 1999 and in common
implementations. This keeps grays gray and keeps more projections in gamut.

Brettel is the only reference model here that covers tritanopia.

### Viénot, Brettel & Mollon 1999 (protan/deutan)

Single projection plane through black, display blue and display yellow, so
the whole thing collapses to one linear-RGB matrix. Implemented as an
alternative/cross-check for protanopia and deuteranopia only; it is **not**
the default and refuses tritan (the paper defines none). It differs from
Brettel by up to ~0.38 in sRGB channel value on saturated colors, which is
why it is not interchangeable with it.

### Machado, Oliveira & Fernandes 2009 (anomalous trichromacy)

Physiologically-based model that shifts one cone class's peak sensitivity;
severity 1.0 corresponds to dichromacy. The authors publish 3x3 matrices at
severity 0.0, 0.1, ..., 1.0 (Table 1, parsed from the authors' page by
`scripts/reference/generate_reference.py` into `machado2009-data.ts` and
cross-checked against a second copy). The matrices are applied to **linear**
RGB. Neither the paper nor the authors' page states the encoding
explicitly (M2.R1: category D); linear is implied by the paper's Eq. 8-10
derivation and matches DaltonLens (see "Open questions"). Treat output as
"Machado 2009, linear-RGB interpretation", not canonical Machado output.

For intermediate severity the authors recommend interpolating linearly
between the two nearest tabulated matrices (weight 0.73 for 0.873 between
0.8 and 0.9). That is implemented as stated. It approximates evaluating
the model at the exact shift; it is not an extra physiological claim.

### Tritanomaly policy

Machado 2009 also tabulates tritanomaly, but its severity-1.0 tritan matrix
disagrees strongly with Brettel 1997 tritanopia (up to ~0.47 in sRGB channel
value on our sample colors, versus ~0.1-0.16 for protan/deutan), and
DaltonLens documents the Machado tritan results as not working well. We are
not aware of an equally validated continuous tritanomaly model, so the
default is **Brettel 1997 tritanopia linearly blended with the original in
linear RGB**, reported as `brettel1997-interpolated` / `approximation`.
`createVisionSimulator({ tritanomaly: 'machado2009' })` selects the Machado
tritan table instead.

### Achromatopsia policy

Gray equal to the Rec. 709 relative luminance (`0.2126 R + 0.7152 G +
0.0722 B` on **linear** RGB, then sRGB-encoded). This approximates "no
chromatic discrimination" only; rod monochromacy follows the scotopic
sensitivity and involves glare and acuity effects that a gray image does not
capture. It does not carry the scientific standing of Brettel or Machado
and is labeled `luminance-approximation`.

## LMS model

Used by Brettel and Viénot (not by Machado, which ships ready-made RGB
matrices). `core/vision/lms.ts`:

- Linear sRGB -> **Judd-Vos corrected XYZ**: the matrix tabulated by
  DaltonLens from Viénot et al. 1999 (`XYZ_JUDD_VOS_FROM_LINEAR_SRGB`),
  built from the sRGB primaries and D65 white.
- Judd-Vos XYZ -> Smith & Pokorny (1975) cone fundamentals
  (`LMS_FROM_XYZ_JUDD_VOS_SMITH_POKORNY_1975`).
- Combined `LMS_FROM_LINEAR_RGB` equals the widely used
  `[17.8824 43.5161 4.11935; 3.45565 27.1554 3.86714; 0.0299566 0.184309
1.46709] / 100`.
- Anchor stimuli for 475/485/575/660 nm are Judd-Vos XYZ values tabulated
  by DaltonLens.

Smith & Pokorny fundamentals are defined on Judd-Vos XYZ, **not** CIE 1931
XYZ. Feeding them CIE 1931 XYZ (what the PyPI release 0.1.5 of
DaltonLens-Python still does) shifts matrix entries by up to ~3.5e-3 and
sRGB outputs by up to ~0.006. We follow the corrected chain, which also
reproduces libDaltonLens's published constants. Different cone fundamentals
or matrices are never mixed within the engine.

## Severity

`severity` is a **model parameter** in `[0, 1]`: 0 = normal vision, 1 =
full deficiency where the model permits (dichromacy-equivalent). It is not a
medical grade; 0.5 is not "50% color blind".

- `severity` outside `[0, 1]` or non-finite throws `RangeError` (fail fast).
- Omitted severity uses `VISION_PROFILE_INFO[profile].defaultSeverity`: 1
  for dichromacies/achromatopsia, 0.5 for anomalies.
- Brettel/Viénot/luminance blend with the unmodified color in linear RGB for
  severity < 1. This is the same mixture used by DaltonLens and is a
  pragmatic approximation of anomalous trichromacy, not part of the 1997/1999
  papers.
- `normal` and `custom` return the input for any valid severity.

## Gamut handling

Projections can leave the sRGB gamut (e.g. protan green gives linear R =
1.1955, protan blue R = -0.307). The policy is **per-channel clipping in
linear light**, then encoding. Consequences: clipping can shift hue and
saturation of strongly saturated colors slightly compared with a
gamut-mapping approach; it is cheap and is what the reference
implementations do. Output channels are always finite and within `[0, 1]`
(exactly 0 or 1 when clipped). Non-finite input channels throw; finite
out-of-range input channels are clamped to `[0, 1]` first.

## Perceptual distance

Simulation and distance are separate layers. `calculatePerceptualDistance`
(`core/color/perceptual-distance.ts`) is the Euclidean distance in OKLab and
returns a continuous value; no thresholds live in M2. `simulatePair`
returns a `VisionAnalysis` with original and simulated colors, original and
simulated distance, `distanceLoss`, the profile, severity and model.

`determineSeverity` in `core/conflicts` still uses the threshold constants
introduced in M1. They were not calibrated against the new engine; their
calibration is future work.

WCAG contrast and CVD distinguishability stay separate signals:
`ColorConflict.contrast` is the WCAG ratio of the _original_ colors and
`ColorConflict.vision` carries the simulation result. Neither replaces the
other.

## Verification

- **Reference vectors** (`tests/fixtures/vision/reference-vectors.json`):
  22 curated colors (black, white, primaries, secondaries, grays, mixed) x
  22 model/family/severity cases, generated by
  `scripts/reference/generate_reference.py` with
  [DaltonLens-Python](https://github.com/DaltonLens/DaltonLens-Python)
  commit `3cba5e6` — an independent implementation, not ColorAdapt code. The
  tests drive the full production pipeline (sRGB decode, model, clip,
  encode). Tolerance 1e-6 on float sRGB (float32 input quantization in the
  reference); 8-bit output within one level. A wrong matrix, anchor, plane
  choice or missing decode would shift results by more than 1e-3.
- **Derived constants** are compared with libDaltonLens's precomputed
  Brettel/Viénot matrices (2e-5).
- **Machado table** was parsed from the authors' page and compared with the
  copy shipped in DaltonLens-Python (identical); spot values for severity 1.0
  are asserted in tests.
- **Invariants**: normal/severity-0 identity, alpha preserved, finite and
  in-range output, determinism, black/white/gray fixed points, projection
  idempotence for Brettel, both half-planes used, severity monotonicity.
- Machado interpolation is tested against a hand-computed midpoint, because
  the reference implementation interpolates incorrectly (below).

### Findings about the reference tooling

1. DaltonLens-Python **0.1.5 (PyPI)** uses CIE 1931 XYZ with Smith & Pokorny
   fundamentals; master (and libDaltonLens) use Judd-Vos XYZ. Master is used.
2. Its `Simulator_Machado2009` interpolation weight is
   `severity - floor(severity*10)/10` (range 0..0.1) instead of `*10`, so
   it is wrong for non-tabulated severities. Machado vectors are generated
   only at tabulated severities (0, 0.3, 0.5, 1.0).

## Scientific review (M2.R1)

| Item              | Finding                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Brettel 1997      | Two half-planes through the neutral axis, anchors 475/575 nm (protan, deutan) and 485/660 nm (tritan), confirmed by DaltonLens' write-up of the paper. Neutral axis is D65 white instead of equal-energy E (documented deviation shared by most implementations).                                                                                                                                                  |
| Brettel constants | ColorAdapt derives plane matrices and separation normal from the anchor XYZ + Judd-Vos/Smith-Pokorny matrices. Derived protan values (plane1 `0.14980 1.19548 -0.34528`, plane2 `0.14570 1.16172 -0.30742`, normal `0.00048 0.00393 -0.00441`) equal libDaltonLens' published constants to 5 decimals. Anchor XYZ values themselves are secondary (DaltonLens tabulation), not re-integrated from spectral tables. |
| Viénot 1999       | Protan/deutan only; the code refuses tritan. Derived protan matrix `0.11238 0.88762 0 / 0.11238 0.88762 0 / 0.00401 -0.00401 1` equals libDaltonLens'.                                                                                                                                                                                                                                                             |
| Machado 2009      | Severity 0..1 (1 = dichromacy), 0.1-step table, linear interpolation recommended by authors. Color space: linear RGB, ENGINEERING CONVENTION (primary source ambiguous, see below). Table 1 equals DaltonLens' copy.                                                                                                                                                                                                                                             |
| Fixture           | Pinned to DaltonLens-Python commit `3cba5e6a7c8f0e8199c8f83f1afb58eb6dab7a3d`; expected vectors are committed with provenance, tolerances and assumptions, and are never generated by production TypeScript.                                                                                                                                                                                                       |
| Tolerances        | Per layer: matrix constants 2e-5; linear RGB / float sRGB 1e-6; 8-bit sRGB within one level.                                                                                                                                                                                                                                                                                                                       |
| Statuses kept     | Tritanomaly and achromatopsia = approximation; `custom` = unsupported (no simulation, treated as normal); severity is engine-level only (UI deferred); M1 conflict thresholds are NOT validated against M2.                                                                                                                                                                                                        |

Scope boundaries: WCAG contrast stays separate from CVD distinguishability;
no threshold calibration happened in M2.R1.

## Determinism and flakiness (M2.R1)

Root cause of the M1 flaky tests (category A, test timing; reproduced by
running the suite beside 24 CPU-bound processes: 10/12 failed before, 0/12
after): tests called `analyzeDocument` / `createContentController` with the
real `performance.now()` and the production 50 ms wall-clock budget. On a
cold or loaded jsdom the budget truncated the pass, so
`dom-analyzer.test.ts` ("reuses the same id...") and the opacity tests saw
different element sets, while `performance.test.ts` (3000 rows) and the demo
smoke test hit vitest's 5 s default. Production behavior was correct: the
budget is a feature. Fix: tests inject a frozen clock (`now: () => 0`); the
budget itself is tested with an injected advancing clock; the large-DOM
test uses 300 rows / `maxElements: 50` (same structural assertion);
`testTimeout` is now an explicit 30 s hang guard.

Policy: no assertion may depend on elapsed time or machine speed; pass an
injected clock to anything with a time budget. M2 code has no module-level
mutable state or caches: simulators hold per-instance model tables, matrices
are derived once into frozen constants, and the only analyzer cache is
created per `analyzeDocument` call (keyed by element, so no cross-document
or cross-profile reuse). `tests/core/vision/policy-and-isolation.test.ts`
guards profile/severity/instance isolation.

## Limitations / open questions

- Models assume a standard (average) observer, 2-degree field, sRGB D65
  display, no surround/adaptation effects, no luminance-level effects.
- The Judd-Vos XYZ matrix and the spectral-anchor XYZ values are taken from
  DaltonLens's tabulation of the published data, not recomputed from the
  original spectral tables here. They agree between two DaltonLens
  artifacts and our derivation, but we did not independently re-derive them
  from CIE/Judd-Vos tables.
- **ENGINEERING CONVENTION — Machado 2009 color space (M2.R1 primary review:
  category D, ambiguous).** Reviewed the full paper PDF
  (`Machado_Oliveira_Fernandes_CVD_Vis2009_final.pdf`, corrected-equations
  version) and the authors' project page. Neither says whether the 3x3
  matrices take linear or gamma-encoded RGB: no occurrence of
  "linear RGB"/"sRGB"/gamma applied to the matrix input (gamma 2.2 appears
  only as the calibration of the CRTs in the user study, Sec. 5.1), and no
  official implementation exists beyond the tabulated matrices. What the
  paper does define: Eq. 8-10 build the RGB->opponent matrix by integrating
  the spectral power distributions R(l), G(l), B(l) of the RGB primaries
  against the opponent basis functions, with gray (0,0,0)-(1,1,1) preserved.
  Integration is linear in primary intensity, so the matrices are
  mathematically consistent only with intensity-proportional (linear) RGB.
  This is a derivation-based inference, **not** an explicit requirement.
  Secondary support: DaltonLens/libDaltonLens decode sRGB before every CVD
  matrix; R `colorspace` switched to linear RGB (v2.1-0). Impact if wrong:
  up to ~70/255 per channel on saturated colors (measured, severity 1.0),
  i.e. material. Therefore output is labelled "Machado 2009, linear-RGB
  interpretation", **not** canonical Machado output; scientific freeze = PARTIAL.
- **Erratum (authors' page, typo in Eqs. 17/18, proceedings p. 1295):**
  factors that belong inside the parenthesis of the last term were typeset
  outside it. The authors state that the paper's images and the supplementary
  matrices were computed with the correct equations. We use only the
  published precomputed matrices (Table 1) and never evaluate Eqs. 17/18, so
  the erratum does not affect this implementation. Table 1 values on the
  authors' page were re-checked against `machado2009-data.ts` (generated from
  that page).
- Anomalous trichromacy via blending (Brettel-interpolated) is not backed by
  strong theory; Machado interpolation between severity steps is the authors'
  own approximation.
- Tritanomaly and achromatopsia are approximations (see above).
- Custom profiles are unsupported (identity).
- No UI for severity yet: the settings schema has no severity field, so the
  popup selects only the profile and the profile's default severity is used.
  The engine API already takes `severity`.
- Conflict thresholds (M1) are uncalibrated against the new engine.

## References

1. Brettel, H., Viénot, F., & Mollon, J. D. (1997). Computerized simulation
   of color appearance for dichromats. _J. Opt. Soc. Am. A_, 14(10),
   2647-2655.
2. Viénot, F., Brettel, H., & Mollon, J. D. (1999). Digital video colourmaps
   for checking the legibility of displays by dichromats. _Color Research &
   Application_, 24(4), 243-252.
3. Machado, G. M., Oliveira, M. M., & Fernandes, L. A. F. (2009). A
   physiologically-based model for simulation of color vision deficiency.
   _IEEE TVCG_, 15(6), 1291-1298.
   <https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html>
4. Smith, V. C., & Pokorny, J. (1975). Spectral sensitivity of the foveal
   cone photopigments between 400 and 500 nm. _Vision Research_, 15, 161-171.
5. IEC 61966-2-1:1999, sRGB.
6. Burrus, N. DaltonLens, <https://daltonlens.org/understanding-cvd-simulation/>,
   <https://github.com/DaltonLens/DaltonLens-Python>,
   <https://github.com/DaltonLens/libDaltonLens> (used only as an independent
   reference, never as a runtime dependency).
7. Ottosson, B. (2020). A perceptual color space for image processing
   (OKLab).
