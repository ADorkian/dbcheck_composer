# DbCheck Composer

UI first composer for dynamic dbCheck regression work.

## What it does

- Uses the existing Vulki auth flow to get a bearer token.
- Calls the current BE regression endpoints directly from the browser.
- Lets the user organize tables, assert data, and import legacy TP templates.
- Can read runtime parameters directly from Docker logs (`STAMPA PARAMETRI`) in Template step.
- Stores saved profiles locally in the browser so the next session can reuse host, dbId, and credentials.

## Run locally

```bash
npm install
npm run dev
```

Or on Windows:

```bat
start-app.bat
```

The app runs on `http://localhost:8095`.

## Build

```bash
npm run build
```

## Notes

- The app does not add a new regression engine.
- Dynamic DBCheck scheduled runs post launch parameters to `/ws/rest/public/v1/{DbId}/regressionConfig`, then poll `/ws/rest/public/v1/statusSched`.
- Dynamic DBCheck catalog autocomplete reads TP catalog resources from `/ws/rest/public/v1/{DbId}/regressiontest/dbcheck/catalogResources`.
- Scheduled results first call legacy `/ws/rest/public/v1/checkResult`, then read structured `/ws/rest/public/v1/{DbId}/regressionResult`.
- Direct runs call `/ws/rest/public/v1/{DbId}/runRT` and poll `/ws/rest/public/v1/{DbId}/verifyRT`.
- TP backend can point the catalog endpoint at local source resources with JVM property `tp.regressiontest.datasetCatalogRoot`.
- Launcher fails fast if port `8095` is already busy.
- Automatic Docker log read requires Docker CLI available on the machine where Vite is running.
