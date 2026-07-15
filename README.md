# Depth Review & Adjustment Dashboard

An interactive, fully static web application for reviewing water-depth time
series and applying manual, reversible depth adjustments — hosted directly on
GitHub Pages. Everything runs in the browser: **no R server, no Shiny, no
backend of any kind**. Built with plain HTML/CSS/JavaScript and
[Plotly.js](https://plotly.com/javascript/) (vendored in `js/vendor/`, no CDN
required).

## Repository layout

```
├── index.html                     # the dashboard (single page)
├── css/style.css                  # layout + light/dark theme tokens
├── js/app.js                      # all application logic
├── js/vendor/plotly-basic.min.js  # Plotly.js basic bundle (vendored)
├── data/
│   ├── manifest.json              # site index, crosswalk, format notes
│   └── sites/<SITE>.json.gz       # one gzipped columnar file per site
├── preprocess/
│   ├── preprocess.py              # RDS -> data/ converter (Python)
│   └── preprocess.R               # the same converter for R users
├── Chunk_01_Blue_Ridge.rds        # original source data (5 chunks)
├── Chunk_02_Central_Maryland.rds
├── Chunk_03_PRV.rds
├── Chunk_04_Roberts_Field.rds
├── Chunk_05_Shannon_Run.rds
├── Depth_Site_Name_Crosswalk.rds  # site-name crosswalk
└── .github/workflows/pages.yml    # GitHub Pages deployment
```

Sites: `BR_2`, `BR_3`, `CM_1`, `CM_2`, `PRV_1`, `PRV_2`, `RF_1`, `RF_2`,
`SR_1`, `SR_3` (≈ 7.3 million records total).

## 1. How the data are preprocessed

Each `Chunk_*.rds` file is an R named list containing one data frame per site
with the columns `DateTime`, `DateTime_GMT_minus_5`, `Depth_m`, `Phase`, and
`Source_Block`. The preprocessing step converts these into a compact,
browser-readable format **once, offline** — the browser never runs R.

Run **either** script from the repository root (they produce the same format):

```bash
# Python (needs: pip install rdata pyreadr pandas numpy)
python3 preprocess/preprocess.py

# or R (needs: install.packages("jsonlite"))
Rscript preprocess/preprocess.R
```

This writes `data/manifest.json` plus one `data/sites/<SITE>.json.gz` per
site. The per-site format is columnar JSON, gzip-compressed (~2–4 MB per site
instead of ~25–35 MB raw):

| Field | Contents |
|---|---|
| `dt` | Original character `DateTime`, **verbatim**, for QA/QC |
| `t0`, `t_delta` | `DateTime_GMT_minus_5` (POSIXct epoch seconds), losslessly delta-encoded; `null` = missing. The Python script round-trip-verifies the encoding for every row |
| `depth` | `Depth_m` at full float precision; `null` = missing |
| `phase_dict` / `phase_rle` | `Phase` as a dictionary + run-length encoding |
| `source_dict` / `source_rle` | `Source_Block`, same encoding |

Nothing is dropped, rounded, reordered, or averaged — all five columns and
every row survive with their original values, and rows stay in their original
order. The crosswalk (`Depth_Site_Name_Crosswalk.rds`) is embedded in
`manifest.json` so the UI can show full site names.

**You only need to re-run preprocessing when the RDS files change**; the
generated `data/` files are committed so GitHub Pages can serve them as-is.

## 2. How the website works

Open the site, pick a site in the left panel, and the app fetches just that
site's `.json.gz` (a few MB) and decompresses it in the browser with the
native `DecompressionStream` API — **data are loaded per site, never all at
once**.

**Center panel — two synchronized Plotly time-series plots:**

* *Original raw depth* (top) and *Adjusted depth* (bottom, with the original
  shown as a muted reference line).
* Drag to zoom, scroll-wheel zoom, pan, hover for details (depth, GMT-5 time,
  original `DateTime` string, `Phase`, `Source_Block`), mode-bar reset/
  autoscale buttons, and a time-range slider under the adjusted plot.
* Zooming or sliding either plot updates both — their time ranges are always
  synchronized (and mirrored in the left panel's date-range inputs).

**Responsiveness with millions of points:** the app plots an adaptive,
piecewise-resolution view. Away from the current window it shows a min/max
downsampled overview; inside the window it re-downsamples on every zoom, and
once fewer than ~25,000 records are visible it switches to the raw samples.
Every plotted point is a *real* sample (min/max bucketing, no averaging), and
gaps in the record stay visible. The underlying data are never modified —
downsampling only affects what is drawn. A note above each plot reports the
current display resolution.

**Left panel:** site selector (with full names from the crosswalk), site
summary (record count, period, phases, missing-value counts), and date-range
controls (start/end inputs plus Full range / Last year / Last 90 d presets).

**Right panel — depth adjustment:**

* Choose an adjustment start and end date-time (GMT−5) — or click *Use
  current view* to copy the plotted window — and a positive or negative
  offset in meters, then *Apply adjustment*.
* The adjusted-depth plot updates immediately. Adjustments can be stacked
  (overlapping windows sum), undone (*Undo last*), or cleared (*Reset all*).
* An adjustment-history table records every step (window, offset, rows
  affected, applied-at time) and is kept per site in your browser's
  `localStorage`, so it survives a page reload on the same machine.
* **`Depth_m` is never overwritten.** Adjustments are applied to a separate
  adjusted-depth array in browser memory only; the published data files and
  the original RDS files are untouched.

**Downloads:**

* *Adjusted data (CSV)* — every record of the selected site with `DateTime`
  (original string), `DateTime_GMT_minus_5`, original `Depth_m`, the adjusted
  depth, the net adjustment applied, `Phase`, and `Source_Block`.
* *Adjustment history (CSV)* — the history table.

**Access gate:** the site shows a full-page password screen before anything
loads; no dashboard data is fetched until the password is accepted. Only a
SHA-256 hash of the password is embedded in `js/auth.js` (no plain text),
the check runs in the browser, and the authenticated state is kept in
`sessionStorage` (a *Log out* button in the header clears it; closing the
browser session also ends it). **This is a client-side gate for a static
GitHub Pages site, not server-side authentication** — the underlying files
remain publicly reachable by URL, so treat it as a deterrent for casual
access, not protection for sensitive data.

**Time handling:** all plotting, range selection, and adjustment windows use
`DateTime_GMT_minus_5` as a fixed-offset GMT−5 wall-clock time (no
daylight-saving shifts, regardless of your computer's time zone). The original
`DateTime` character strings are retained verbatim for QA/QC in hover text and
CSV exports.

## 3. GitHub Pages deployment

The site is 100 % static and is served from the **`gh-pages` branch**, which
GitHub Pages enabled automatically the first time that branch was pushed —
no repository settings are required. The live site is
`https://<user>.github.io/<repository>/`.

Deployment is automatic: on every push to `main`, the included workflow
(`.github/workflows/pages.yml`) assembles `index.html`, `.nojekyll`, `css/`,
`js/`, and `data/` (the multi-MB source `.rds` files are excluded) and
force-pushes the result to `gh-pages`; GitHub Pages then publishes it within
a minute or two. The workflow can also be run on demand from the Actions tab
(*workflow_dispatch*).

To confirm or change the Pages source, see **Settings → Pages** — it should
read *Deploy from a branch: `gh-pages` / (root)*.

### Running locally

Browsers block `fetch()` from `file://`, so use any static file server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

### Browser support

Any current Chrome, Edge, Firefox, or Safari (the app uses the
`DecompressionStream` API, available in all evergreen browsers since 2023).

## Updating the data

1. Replace the `Chunk_*.rds` (and, if needed, crosswalk) files.
2. Re-run `python3 preprocess/preprocess.py` (or the R script).
3. Commit the regenerated `data/` directory and push — Pages redeploys
   automatically.
