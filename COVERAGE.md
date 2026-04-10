# Coverage

This MCP server covers five Italian financial regulation sourcebooks.
Data age and freshness metadata are tracked in [`data/coverage.json`](data/coverage.json).

## Sourcebooks

| ID | Name | Official URL |
|----|------|-------------|
| `CONSOB_EMITTENTI` | CONSOB Regolamento Emittenti | https://www.consob.it/web/area-pubblica/regolamenti |
| `CONSOB_INTERMEDIARI` | CONSOB Regolamento Intermediari | https://www.consob.it/web/area-pubblica/regolamenti |
| `BDI_285` | Banca d'Italia Circolare 285 | https://www.bancaditalia.it/compiti/vigilanza/normativa/index.html |
| `BDI_288` | Banca d'Italia Circolare 288 | https://www.bancaditalia.it/compiti/vigilanza/normativa/index.html |
| `IVASS_38` | IVASS Regolamento 38 | https://www.ivass.it/normativa/nazionale/secondaria-ivass/regolamenti/ |

## Data Freshness

The `data_age` field in `data/coverage.json` records the date of the last data ingest.
A weekly CI workflow (`.github/workflows/check-freshness.yml`) warns if data is older than 6 months.
A monthly CI workflow (`.github/workflows/ingest.yml`) re-ingests data from official sources.
