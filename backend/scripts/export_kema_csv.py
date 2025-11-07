#!/usr/bin/env python
"""Run the KEMA strategy against a CSV candle file and export indicator data.

The script expects the input CSV to contain at least the following columns:
    time (unix seconds) or timestamp (ISO8601)
    open, high, low, close
    volume

It produces an output CSV with the columns:
    time, open, high, low, close, EMA, Upper, Lower, Volume

Example usage:
    python backend/scripts/export_kema_csv.py \
        --input data/sample.csv \
        --output data/output.csv \
        --pine backend/tests/fixtures/kema_strategy.pine
"""

from __future__ import annotations

import argparse
import csv
import math
from decimal import Decimal, InvalidOperation
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.schemas import BacktestRequest, PineScriptStrategy
from app.services.backtest_engine import _run_kema_option
from app.services.pine_parser import KemaOptionConfig, PineScriptParseError, parse_pine_script


@dataclass
class CsvCandle:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


DEFAULT_PINE_CODE = """// Default KEMA strategy used when --pine is not provided
//@version=4
strategy("KEMA Option Strategy", overlay=true)

length_ema = input.int(5, title="EMA Length")
length_atr = input.int(5, title="ATR Length")
volatility_factor = input.float(0.25, title="Volatility Factor")
initial_risk = input(2, title="Initial Risk (%)") / 100
risk_equity = input(0.5, title="Risk Equity (%)") / 100

startYear = input.int(1970, "Start Year")
startMonth = input.int(1, "Start Month")
startDay = input.int(1, "Start Day")
endYear = input.int(2100, "End Year")
endMonth = input.int(12, "End Month")
endDay = input.int(31, "End Day")

trade_option = input.string("Both", "Trade Option", options=["Long Only", "Short Only", "Both"])

kema = ta.ema(close, length_ema)
atr = ta.atr(length_atr)
upper_band = kema + volatility_factor * atr
lower_band = kema - volatility_factor * atr

if crossover(close, upper_band)
    strategy.entry("Long", strategy.long)
else if crossunder(close, lower_band)
    strategy.entry("Short", strategy.short)

if crossunder(close, lower_band)
    strategy.close("Long")
else if crossover(close, upper_band)
    strategy.close("Short")
"""


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run KEMA strategy against CSV candles")
    parser.add_argument("--input", required=True, type=Path, help="Path to the input CSV file")
    parser.add_argument("--output", required=True, type=Path, help="Path to the output CSV file")
    parser.add_argument("--pine", type=Path, default=None, help="Optional Pine script file to parse")
    parser.add_argument("--symbol", default="CSV", help="Symbol label to embed in the request")
    parser.add_argument("--timeframe", default="1d", help="Timeframe label for the backtest request")
    parser.add_argument("--initial-capital", type=float, default=10000.0, help="Initial capital for the backtest")
    parser.add_argument("--trading-fee", type=float, default=0.0, help="Trading fee percentage")
    parser.add_argument("--ema-length", type=int, help="Override EMA length used by the strategy")
    parser.add_argument("--atr-length", type=int, help="Override ATR length used by the strategy")
    parser.add_argument(
        "--volatility-factor",
        type=float,
        help="Override volatility factor multiplier (e.g. 0.25)",
    )
    parser.add_argument(
        "--initial-risk",
        type=float,
        help="Override initial risk fraction (e.g. 0.02 for 2%)",
    )
    parser.add_argument(
        "--risk-equity",
        type=float,
        help="Override risk-equity fraction (e.g. 0.005 for 0.5%)",
    )
    parser.add_argument(
        "--trade-option",
        choices=["both", "long_only", "short_only"],
        help="Override trade direction option",
    )
    parser.add_argument(
        "--start-date",
        help="Override backtest start date (YYYY-MM-DD or ISO8601)",
    )
    parser.add_argument(
        "--end-date",
        help="Override backtest end date (YYYY-MM-DD or ISO8601)",
    )
    parser.add_argument(
        "--use-kema",
        dest="use_kema",
        action="store_true",
        default=None,
        help="Enable adaptive KEMA mid-band when supported by the Pine script",
    )
    return parser.parse_args()


def _load_pine_code(pine_path: Optional[Path]) -> str:
    if pine_path is None:
        return DEFAULT_PINE_CODE
    return pine_path.read_text(encoding="utf-8")


def _parse_candles(csv_path: Path) -> List[CsvCandle]:
    candles: List[CsvCandle] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError("CSV is missing a header row")
        header_lookup = {name.lower(): name for name in reader.fieldnames if name}
        required = {"open", "high", "low", "close"}
        missing = required - set(header_lookup.keys())
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}")

        volume_key: Optional[str] = None
        for candidate in ["volume", "vol", "volume_usd", "volume_quote", "volume_btc"]:
            if candidate in header_lookup:
                volume_key = header_lookup[candidate]
                break

        for row in reader:
            if row is None:
                continue
            time_value = _first_present(row, ["time", "timestamp", "date", "Time", "Timestamp"])
            if time_value is None:
                raise ValueError("CSV row is missing a time or timestamp column")
            timestamp = _parse_timestamp(time_value)
            try:
                open_price = float(row[header_lookup["open"]])
                high_price = float(row[header_lookup["high"]])
                low_price = float(row[header_lookup["low"]])
                close_price = float(row[header_lookup["close"]])
            except (TypeError, ValueError, KeyError) as exc:
                raise ValueError(f"Unable to parse OHLC values for row {row}") from exc

            volume = 0.0
            if volume_key:
                raw_volume = row.get(volume_key)
                if raw_volume not in (None, ""):
                    try:
                        volume = float(raw_volume)
                    except ValueError:
                        raise ValueError(f"Unable to parse volume '{raw_volume}' in row {row}")

            candles.append(
                CsvCandle(
                    timestamp=timestamp,
                    open=open_price,
                    high=high_price,
                    low=low_price,
                    close=close_price,
                    volume=volume,
                )
            )

    candles.sort(key=lambda c: c.timestamp)
    return candles


def _first_present(row: dict, keys: Iterable[str]) -> Optional[str]:
    for key in keys:
        if key in row and row[key]:
            return row[key]
    return None


def _parse_timestamp(value: str) -> datetime:
    value = value.strip()
    if not value:
        raise ValueError("Empty timestamp value")
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except ValueError:
        pass

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Unable to parse timestamp: {value}") from exc

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed


def _format_float(value: Optional[float]) -> str:
    if value is None or (isinstance(value, float) and not math.isfinite(value)):
        return "NaN"
    if isinstance(value, float):
        try:
            decimal_value = Decimal(str(value)).normalize()
            text = format(decimal_value, "f")
        except (InvalidOperation, ValueError):
            text = format(value, ".15g")
    else:
        text = str(value)
    if text in {"-0", "-0.0"}:
        return "0"
    return text


def _parse_override_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        try:
            parsed = datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise SystemExit(f"Invalid date format: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed


def _apply_overrides(config: KemaOptionConfig, args: argparse.Namespace) -> KemaOptionConfig:
    resolved_use_kema = config.use_kema if args.use_kema is None else args.use_kema

    updated = KemaOptionConfig(
        ema_length=args.ema_length or config.ema_length,
        atr_length=args.atr_length or config.atr_length,
        volatility_factor=
        args.volatility_factor if args.volatility_factor is not None else config.volatility_factor,
        initial_risk=args.initial_risk if args.initial_risk is not None else config.initial_risk,
        risk_equity=args.risk_equity if args.risk_equity is not None else config.risk_equity,
        trade_option=args.trade_option or config.trade_option,
        start_date=_parse_override_date(args.start_date) if args.start_date else config.start_date,
        end_date=_parse_override_date(args.end_date) if args.end_date else config.end_date,
        use_kema=resolved_use_kema,
    )

    # Basic validation to avoid invalid values slipping through CLI overrides
    if updated.ema_length <= 0:
        raise SystemExit("EMA length must be positive")
    if updated.atr_length <= 0:
        raise SystemExit("ATR length must be positive")
    if updated.initial_risk < 0 or updated.risk_equity < 0:
        raise SystemExit("Risk parameters must be non-negative")

    return updated


def _export_csv(output_path: Path, candles: List[CsvCandle], response, use_kema: bool) -> None:
    annotated = response.annotatedCandles
    if len(annotated) != len(candles):
        raise RuntimeError("Annotated candle count does not match input rows")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        header = ["time", "open", "high", "low", "close", "EMA"]
        if use_kema:
            header.append("KEMA")
        header.extend(["Upper", "Lower", "Volume"])
        writer.writerow(header)
        for candle, annotated_candle in zip(candles, annotated):
            timestamp = annotated_candle.timestamp
            epoch_seconds = int(timestamp.timestamp())
            ema = annotated_candle.indicators.get("EMA")
            upper = annotated_candle.indicators.get("Upper Band")
            lower = annotated_candle.indicators.get("Lower Band")
            row = [
                epoch_seconds,
                _format_float(candle.open),
                _format_float(candle.high),
                _format_float(candle.low),
                _format_float(candle.close),
                _format_float(ema),
            ]
            if use_kema:
                kema = annotated_candle.indicators.get("KEMA Adaptive")
                row.append(_format_float(kema))
            row.extend([
                _format_float(upper),
                _format_float(lower),
                _format_float(candle.volume),
            ])
            writer.writerow(row)


def main() -> None:
    args = _parse_args()

    pine_code = _load_pine_code(args.pine)
    try:
        strategy_config = parse_pine_script(pine_code)
    except PineScriptParseError as exc:
        raise SystemExit(f"Failed to parse Pine script: {exc}")

    if not isinstance(strategy_config, KemaOptionConfig):
        raise SystemExit("Provided Pine script does not describe a KEMA option strategy")

    strategy_config = _apply_overrides(strategy_config, args)

    candles = _parse_candles(args.input)
    request = BacktestRequest(
        initialCapital=args.initial_capital,
        tradingFee=args.trading_fee,
        symbol=args.symbol,
        timeframe=args.timeframe,
        strategyRules=PineScriptStrategy(type="pine_script", code=pine_code),
    )

    response = _run_kema_option(candles, strategy_config, request)
    _export_csv(args.output, candles, response, strategy_config.use_kema)
    print(f"Exported {len(candles)} rows to {args.output}")


if __name__ == "__main__":
    main()
