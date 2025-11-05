# Trading Backtest Lab

A full-stack backtesting playground with a TradingView-inspired UI. Upload OHLCV data, edit strategy parameters or Pine Script, and run deterministic backtests with equity and trade analytics.

## Stack

- **Backend:** FastAPI, SQLAlchemy, SQLite
- **Frontend:** React + TypeScript (Vite), Lightweight Charts, Recharts
- **Tooling:** PyTest, ESLint

## Project layout

```text
backend/
  app/
    main.py              # FastAPI app entry
    models.py            # SQLAlchemy models
    schemas.py           # Pydantic request/response models
    routers/             # API routers (price-data, backtest)
    services/            # Backtest engine + Pine script parser
    database.py          # DB session helpers
  tests/                 # PyTest suite for backtest engine
  requirements.txt
frontend/
  src/
    pages/BacktestTradingPage.tsx
    components/*         # Charts, metrics, tables
    api/*                # Axios client + DTOs
    styles.css
  package.json
  vite.config.ts
```

CSV uploads live in `data/` (ignored by git), while SQLite persists as `backend/backtest.db`.

## Prerequisites

- Python 3.11+
- Node.js 18+
- npm (bundled with Node)

## Backend setup

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The API serves at `http://127.0.0.1:8000`. Key routes:

- `POST /price-data/import` – upload CSV OHLCV data
- `GET /price-data/datasets` – list imported symbols/timeframes
- `GET /price-data/candles` – fetch candles for charting
- `POST /backtest/run` – execute a backtest
- `GET /health` – simple health probe

### CSV import format

Headers must contain: `timestamp, open, high, low, close, volume`. Example row:

```text
2024-01-01T00:00:00Z,42000,42100,41950,42080,123.45
```

`timestamp` is parsed as UTC. The import request requires `symbol` and `timeframe` form fields (e.g., `BTCUSDT` / `1h`). Existing data for that pair is replaced by default.

## Frontend setup

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173/backtest-trading` to access the TradingView-like workspace. The UI provides:

- Left panel: dataset picker, CSV import, capital & fee controls, MA/Pine strategy config
- Main area: candlestick chart with buy/sell markers, metrics, equity curve, sortable trades table
- Right panel: collapsible strategy code editor (JSON + Pine Script tabs)

## Running a moving average cross strategy

1. Import candles via the UI or call the API:
   ```powershell
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/price-data/import" `
     -Form @{ symbol="BTCUSDT"; timeframe="1h"; replaceExisting="true"; file=Get-Item .\data\btc.csv }
   ```
2. In the left panel, choose the dataset, set initial capital (e.g., `10000`) and trading fee (e.g., `0.1`).
3. Under **Strategy Tester**, keep **Moving Average** selected and adjust:
   - Fast MA (e.g., 10)
   - Slow MA (e.g., 25)
   - Price source (close/open)
   - Optional: enable short entries
4. Click **Run Backtest**. Metrics, equity curve, and trades populate instantly.

Equivalent JSON payload for the API:

```json
{
  "initialCapital": 10000,
  "tradingFee": 0.1,
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "strategyRules": {
    "type": "moving_average_cross",
    "fastWindow": 10,
    "slowWindow": 25,
    "source": "close",
    "allowShort": false
  }
}
```

## Pine Script workflow

The backend ships with a lightweight Pine Script parser that recognises SMA crossover templates. Example script (preloaded in the UI):

```pine
//@version=5
strategy("MA Cross", overlay=true)
fastLength = input.int(10, minval=1, title="Fast MA")
slowLength = input.int(25, minval=1, title="Slow MA")
fastMA = ta.sma(close, fastLength)
slowMA = ta.sma(close, slowLength)
if ta.crossover(fastMA, slowMA)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fastMA, slowMA)
    strategy.close("Long")
```

Paste or edit Pine script in the right panel, switch the strategy type to **Pine Script**, and run the backtest. Parsing errors return a concise message in the UI toast.

_Notes_: The parser currently supports SMA-based entry/exit signals with `ta.crossover` / `ta.crossunder`. Extend `app/services/pine_parser.py` to recognise more constructs.

## Strategy code JSON editor

The collapsible right panel mirrors the `strategyRules` payload sent to the backend. Edit the JSON, hit **Apply JSON**, and the left-side form syncs automatically. This is handy for quick experimentation or sharing scenarios.

## Testing

```powershell
cd backend
.venv\Scripts\Activate.ps1
pytest

cd ../frontend
npm run lint
npm run build
```

The backend test suite validates the deterministic moving-average engine against seeded candles.

## API reference (summary)

- **POST /price-data/import** (`multipart/form-data`)
  - `symbol`, `timeframe`, `file`, `replaceExisting`
- **GET /price-data/datasets** → `[ { symbol, timeframe, earliest, latest, candles } ]`
- **GET /price-data/candles?symbol=BTCUSDT&timeframe=1h&limit=500`**
- **POST /backtest/run**
  - Request: see JSON above (+ optional `startTime`, `endTime` ISO timestamps)
  - Response:
    ```json
    {
      "totalProfit": 97.8,
      "roiPercent": 9.78,
      "maxDrawdown": 4.12,
      "winrate": 55.56,
      "numberOfTrades": 9,
      "equityCurve": [{ "timestamp": "2024-01-01T00:00:00", "equity": 10000 }, ...],
      "executedTrades": [{ "entryTime": "…", "exitTime": "…", "profit": 53.2, "type": "buy" }]
    }
    ```

## Next steps

- Broaden Pine Script support (inputs, risk controls, more indicators)
- Add portfolio-level simulations across multiple symbols
- Persist uploaded datasets and backtest results with user accounts

Happy backtesting! 🚀
