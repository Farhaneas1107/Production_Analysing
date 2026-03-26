# Production Analysing

A browser-based tool for analysing micro metrics and production data exported from the ENLYZE platform.

## Project Structure

| File | Description |
|------|-------------|
| `analyzer_v2.html` | Latest analyser (V2) |
| `analyzer_v1.html` | Original analyser (V1) |
| `analyzer.js` | Analyser logic |
| `analyzer.css` | Analyser styles |
| `serve_analyzer.ps1` | Local HTTP server for the analyser |
| `discover_micro_metrics.ps1` | Discovers available micro metric IDs |

## Running Locally

```powershell
.\serve_analyzer.ps1
```

Open `http://localhost:8080` in your browser.

## Data Files

> `micro_metrics_export.json` (~89 MB) is excluded from Git — too large for GitHub.  
> Generate it locally using `discover_micro_metrics.ps1`.
