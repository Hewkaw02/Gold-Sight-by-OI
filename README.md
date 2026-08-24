# Gold Sight by OI

Static GC futures price line chart with a time-price Options Open Interest wall overlay.

The dashboard is intentionally static so it can be hosted on GitHub Pages. The collector is standalone: the required CME login, Vol2Vol, options-chain, and parser functions live in this repository under `collector/cme/`. It does not call or modify another project at runtime.

## What is implemented

- `BLACKBULL:GOLD.F` price history at `4H` and `1D`; `latest.json` may include the current open candle, while the chart and model use closed bars only.
- Partitioned JSON with `latest.json` indexes and atomic writes.
- GC Vol2Vol tenor snapshots for target DTE `7/15/30/60/90`, with `close → mid → open` selection. When a far tenor is not present in Vol2Vol, verified all-expiry chain snapshots fill only the additional `60D/90D` front-equivalent buckets.
- Separate `All expiries` OI layer built from the standalone CME options-chain function, preserving far-dated contracts/LEAPS alongside the default front-equivalent view.
- Deduplication by unique `expiry_date + strike`, so multiple tenor labels do not double-count OI.
- OI enrichment from the standalone CME options function when the Vol2Vol tenor page supplies volume/IV but no OI.
- Dynamic P90 significance threshold per snapshot.
- Wall modes: `Combined`, `Call only`, `Put only`, and `Split`.
- Noise filters for minimum wall strength and Call/Put/Balanced dominance; `Front equivalent` also exposes selectable `7D`, `15D`, `30D`, `60D`, and `90D` coverage chips. The DTE chips filter provenance coverage while keeping each displayed OI value as the front composite, so the UI does not imply a single-tenor recalculation.
- Visible Minimum OI slicer filters walls from `1,000` through `10,000` OI in `500`-contract steps, using the active Call/Put/Total Wall mode and updating the wall count live.
- Dominance score from `-1` Put to `+1` Call; raw Call/Put/Total OI remains in tooltip/data.
- Wall colors distinguish unexpired walls (Call/Put dominance colors), expired walls (muted slate dashed lines), and composite walls containing both states (amber dotted lines); the tooltip and Series details view label the state explicitly.
- Expiry visibility filters hide fully expired and mixed-expiry walls by default without deleting the source JSON; each state can be shown independently from the dashboard.
- Wall width emphasizes OI at or above `10,000` in the active Wall mode; near-balanced Call/Put walls (dominance within ±15%) use a neutral white color instead of Call/Put dominance colors.
- Wall lines extend through the latest expiry date represented by the composite wall, so future support/resistance horizons remain visible instead of stopping at the last observed snapshot.
- `Chart / Series details` view shows the expiry-series inventory, expiry status, DTE coverage, wall counts, strike levels, OI, dominance, chart period, and wall lifecycle using the same active filters as the chart.
- Dashboard defaults to a June-to-date chart window and can show a selected `30D/60D/90D` forecast horizon; the forecast is explicitly labeled as a guide, not actual market data.
- The price forecast uses a rolling-origin weighted ensemble of naive, median-drift, EMA-reversion, and damped-trend candidates. Model weights come from walk-forward MAE/MAPE, with EMA, robust volatility, trend R², and a trend/range/volatile regime summary exposed in the chart tooltip.
- The options-aware prediction pipeline processes the full active expiry surface into `prediction/GC/latest.json`: composite and nearest-expiry Max Pain, Black-76 Delta/Gamma/Vanna exposure, Gamma flip, IV coverage, fallback-volatility warnings, and a bounded options scenario guide layered on the historical ensemble forecast. The signed OI convention is explicitly heuristic because OI alone does not reveal dealer positioning.
- The forecast includes an optional estimated 80% range derived from backtest error plus robust volatility (off by default so uncertainty does not distort the price scale), while the expiry-aware dominance outlook uses the same selected horizon and carries forward the latest verified EOD OI while removing contracts as they expire.
- Wall segment lifecycle with expiry/roll termination, two-trading-session stale grace, and provenance.
- Auth/data health banner for `LIVE`, `PARTIAL`, `STALE`, `ERROR`, and CME login challenge.
- GitHub Actions collection, CI, GHCR image publishing, and Pages deployment.

## Local development

```powershell
npm install
npm run dev
```

The checked-in `public/data` contains a safe demo/normalized seed so the UI works without credentials.

Build and verify:

npm run typecheck
npm test
npm run build

## Docker

The easiest Windows commands are:

```powershell
.\scripts\docker.ps1 dashboard  # build + run Dashboard
.\scripts\docker.ps1 scheduler  # start the separate scheduled collector
.\scripts\docker.ps1 refresh    # refresh price and rebuild derived JSON
.\scripts\docker.ps1 live-oi    # collect CME OI; requires .env credentials/session
.\scripts\docker.ps1 status
.\scripts\docker.ps1 down
```

Open `http://localhost:8080`. If that port is already in use, set `$env:DASHBOARD_PORT = '8085'` before running the helper. The dashboard container mounts `public/data` read-only, so refreshed JSON appears immediately without rebuilding the dashboard image. The `dashboard` helper also starts the separate `scheduler` container.

The scheduler is a long-running container separate from the one-shot `collector`. It refreshes anonymous TradingView price data every 15 minutes on weekdays, performs one OI/contract-expiry refresh at startup on weekdays, and then runs CME OI at `07:50`, `09:55`, and `12:20` in `America/Chicago` by default. It rechecks the CME session before each OI run, serializes price/OI jobs so they cannot write simultaneously, and keeps a heartbeat at `runtime/scheduler/heartbeat.json`. Configure `SCHEDULER_TIMEZONE`, `SCHEDULER_PRICE_INTERVAL_MINUTES`, `SCHEDULER_RUN_OI_ON_START`, `SCHEDULER_STARTUP_OI_SLOT`, and `SCHEDULER_OI_SCHEDULE` in `.env` when needed.

Equivalent raw Docker Compose commands:

```powershell
docker compose up -d --build dashboard scheduler
```

The container serves `/healthz` for health checks and disables caching for normalized JSON. The collector image includes Python/tvdatafeed and Camoufox. The `collector` service remains a one-shot/manual job; the separate scheduler is the continuously running service:

```powershell
docker compose --profile collector build collector
docker compose --profile collector run --rm -e RUN_LIVE_OI=false collector
docker compose up -d --build scheduler dashboard
```

For live OI, create a local `.env` from `.env.example`, add `CME_EMAIL` and `CME_PASSWORD`, then run:

```powershell
docker compose --profile collector run --rm -e RUN_LIVE_OI=true collector
```

`public/data` and `runtime` are bind-mounted as shown in `compose.yaml`; keep CME credentials and the saved browser session outside the image. The scheduler keeps running and the dashboard reads the same normalized JSON files, so new data becomes visible without rebuilding the dashboard image.

## Local seed / rebuild

The seed command rebuilds derived walls and manifests from the normalized JSON already inside this repository. It does not read another project or copy external files.

```powershell
$env:GOLD_SIGHT_DATA_ROOT = 'public/data'
npm run collector:seed
```

`sourceFile`, `rawSha256`, `oiAsOfDate`, and `oiSource` are retained so the dashboard data can be audited. `oiSource` is one of `vol2vol`, `options_chain_eod`, `mixed`, or `missing`.

## Credentials and automated CME login

Do not commit `.env`, cookie files, or credentials. TradingView credentials are not required by the current price adapter: it calls `TvDatafeed()` anonymously unless both optional `TV_USERNAME` and `TV_PASSWORD` variables are supplied for a symbol that TradingView limits.

The self-hosted runner reads:

- `CME_EMAIL` / `CME_PASSWORD` — used only when the saved CME session has expired and a fresh login is needed.
- optional `CME_STORAGE_STATE_PATH` — the saved Camoufox/CME browser session file; it avoids logging in every run and is sensitive session data. The default is `runtime/cme-storage-state.json`.

`npm run auth:cme` first reuses the cookie file and only opens Camoufox login when the Vol2Vol access check fails. If CME presents MFA/CAPTCHA, it writes `auth.state = challenge` to the public status JSON and stops without replacing good OI data. It does not attempt to bypass the challenge.

Camoufox is installed as a dependency of this repository; no external GetDataCMEBoy installation is required.

## GitHub Actions / Pages

1. Create or connect the repository and push this project to its `main` branch.
2. Add repository secrets `CME_EMAIL` and `CME_PASSWORD`. They are only used when the saved CME session needs a fresh login.
3. `collect.yml` uses a fresh GitHub-hosted `windows-latest` runner, so no local self-hosted runner installation is required. Add `CME_EMAIL` and `CME_PASSWORD` as repository secrets because the temporary runner must authenticate to CME on every OI run.
4. Set Pages source to **GitHub Actions** and enable the `github-pages` environment.
5. Enable Actions and allow the workflow token to write repository contents. The data workflows already declare `contents: write`.

`price-refresh.yml` runs the anonymous TradingView price refresh every 15 minutes on weekdays, uses the candle close time to keep the newest completed 1D/4H bar, verifies freshness, and commits only normalized/public JSON. `collect.yml` runs the standalone CME collector on a fresh GitHub-hosted Windows runner at the configured GC open/mid/close schedule in `America/Chicago` (`07:50`, `09:55`, `12:20` weekdays). The browser session is temporary and is recreated through the repository secrets on every run. Both workflows share a concurrency group so data commits do not race. The single Pages workflow deploys every pushed normalized dataset, while `docker-publish.yml` publishes the dashboard image to GHCR on `main`/version tags.

The Pages workflow also listens for successful completion of the two data workflows. This is required because a commit made with the default `GITHUB_TOKEN` does not start another workflow from a `push` event. The Docker publish workflow produces two images: the dashboard image and a `-collector` image for an always-on Docker host.

GitHub Actions can run the scheduled collector jobs, but hosted runners are temporary and are destroyed after a job. This is fine for the current design because the collector commits normalized JSON before the job ends; a CME CAPTCHA/MFA challenge can still require a manual rerun or a dedicated self-hosted runner. Use `price-refresh.yml` and `collect.yml` for GitHub-hosted scheduling, or run the `scheduler` service from `compose.yaml` on an always-on machine. TradingView credentials remain optional; the adapter uses anonymous access unless both `TV_USERNAME` and `TV_PASSWORD` are supplied.

GitHub scheduled workflows can be delayed under load, so the freshness check fails when price data exceeds the configured grace period instead of silently publishing an old dataset. A daily bar can legitimately remain one session behind until its exchange candle close; the adapter now checks `closeTime <= now` rather than discarding the final returned row unconditionally.

## Data layout

```text
public/data/
  price/GC/4h/YYYY/MM/YYYY-MM-DD.json
  price/GC/4h/latest.json
  price/GC/1d/YYYY/MM/YYYY-MM-DD.json
  price/GC/1d/latest.json
  oi/GC/YYYY-MM-DD/{slot}-{targetDte}dte.json
  oi/GC/latest.json
  oi/GC/all-expiry/YYYY-MM-DD.json
  oi/GC/all-expiries-latest.json
  oi/GC/dominance-outlook.json
  prediction/GC/latest.json
  walls/GC/latest.json
  walls/GC/all-expiries-latest.json
  rolls/GC/latest.json
  status/latest.json
  manifest.json
```

Raw browser/CME payloads stay on the self-hosted runner. The public site receives only normalized/derived records required for the chart and audit metadata.
