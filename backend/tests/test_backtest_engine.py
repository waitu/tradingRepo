import math
from datetime import datetime, timedelta

from sqlalchemy import create_engine  # type: ignore[import]
from sqlalchemy.orm import Session, sessionmaker  # type: ignore[import]

from app.database import Base
from app.models import PriceCandle
from app.schemas import BacktestRequest, MovingAverageCrossStrategy, PineScriptStrategy
from app.services.backtest_engine import Position, _close_and_record_trade, run_backtest


def _setup_session() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    return TestingSessionLocal()


def _seed_candles(db: Session) -> None:
    start = datetime(2024, 1, 1)
    prices = [100, 101, 102, 105, 104, 100, 98, 101, 103, 106]
    for idx, price in enumerate(prices):
        candle = PriceCandle(
            timestamp=start + timedelta(hours=idx),
            open=price,
            high=price + 1,
            low=price - 1,
            close=price,
            volume=1_000 + idx,
            symbol="BTCUSDT",
            timeframe="1h",
        )
        db.add(candle)
    db.commit()


def _seed_candles_with_spread(db: Session, symbol: str) -> None:
    start = datetime(2024, 1, 1)
    prices = [100, 101, 102, 105, 104, 100, 98, 101, 103, 106]
    for idx, price in enumerate(prices):
        open_price = price - 0.6
        close_price = price + 0.6
        high_price = max(open_price, close_price) + 1.0
        low_price = min(open_price, close_price) - 1.0
        candle = PriceCandle(
            timestamp=start + timedelta(hours=idx),
            open=open_price,
            high=high_price,
            low=low_price,
            close=close_price,
            volume=1_500 + idx,
            symbol=symbol,
            timeframe="1h",
        )
        db.add(candle)
    db.commit()


PINE_KEMA_CODE = """
//@version=4
strategy("KEMA Option Strategy", overlay=true)

length_ema = input.int(5, title="EMA Length")
length_atr = input.int(5, title="ATR Length")
volatility_factor = input.float(0.25, title="Volatility Factor")
initial_risk = input(2, title="Initial Risk (%)") / 100
risk_equity = input(0.5, title="Risk Equity (%)") / 100

startYear = input.int(2023, "Start Year")
startMonth = input.int(1, "Start Month")
startDay = input.int(1, "Start Day")
endYear = input.int(2026, "End Year")
endMonth = input.int(12, "End Month")
endDay = input.int(31, "End Day")

trade_option = input.string("Both", "Trade Option", options=["Long Only", "Short Only", "Both"])
use_kema = input.bool(false, "Use KEMA (Adaptive EMA)")

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

PINE_KEMA_WITH_TOGGLE_CODE = PINE_KEMA_CODE.replace(
    "input.bool(false, \"Use KEMA (Adaptive EMA)\")",
    "input.bool(true, \"Use KEMA (Adaptive EMA)\")",
)


def test_backtest_engine_ma_cross_generates_profit():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
        ),
    )

    result = run_backtest(db, request)

    assert result.numberOfTrades > 0
    assert result.totalProfit != 0
    assert len(result.equityCurve) > 0


def test_backtest_engine_kema_pine_script_executes():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        strategyRules=PineScriptStrategy(type="pine_script", code=PINE_KEMA_CODE),
    )

    result = run_backtest(db, request)

    assert result.numberOfTrades >= 0
    assert len(result.equityCurve) > 0


def test_backtest_engine_kema_respects_warmup_before_trades():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        strategyRules=PineScriptStrategy(type="pine_script", code=PINE_KEMA_CODE),
    )

    result = run_backtest(db, request)

    annotated = result.annotatedCandles
    assert annotated, "Expected annotated candles to be returned"

    first_indicator_idx = next(
        (idx for idx, candle in enumerate(annotated) if candle.indicators["Upper Band"] is not None),
        None,
    )
    assert first_indicator_idx is not None, "Upper band never became available"

    for idx in range(first_indicator_idx):
        indicators = annotated[idx].indicators
        assert indicators["Upper Band"] is None
        assert indicators["Lower Band"] is None

    if result.executedTrades:
        earliest_entry = min(trade.entryTime for trade in result.executedTrades)
        if first_indicator_idx + 1 < len(annotated):
            earliest_allowed_time = annotated[first_indicator_idx + 1].timestamp
        else:
            earliest_allowed_time = annotated[first_indicator_idx].timestamp
        assert earliest_entry >= earliest_allowed_time


def test_backtest_engine_kema_toggle_outputs_adaptive_indicator():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        strategyRules=PineScriptStrategy(type="pine_script", code=PINE_KEMA_WITH_TOGGLE_CODE),
    )

    result = run_backtest(db, request)

    assert "KEMA Adaptive" in result.indicatorLines
    annotated = result.annotatedCandles
    assert any(
        candle.indicators.get("KEMA Adaptive") is not None for candle in annotated
    ), "Expected adaptive KEMA values in annotated candles"


def test_round_quantity_enforces_lot_floor_for_spot():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        lot_size=0.5,
        round_quantity=True,
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
        ),
    )

    result = run_backtest(db, request)

    assert result.executedTrades, "Expected at least one trade for rounding check"
    assert math.isclose(result.lot_size, request.lot_size)
    assert result.round_quantity is True
    for trade in result.executedTrades:
        remainder = math.fmod(trade.positionSize, request.lot_size)
        assert math.isclose(remainder, 0.0, abs_tol=1e-8) or math.isclose(remainder, request.lot_size, abs_tol=1e-8)


def test_round_quantity_disabled_preserves_fractional_size():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        lot_size=1.0,
        round_quantity=False,
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
        ),
    )

    result = run_backtest(db, request)

    assert result.executedTrades, "Expected trades when rounding disabled"
    assert math.isclose(result.lot_size, request.lot_size)
    assert result.round_quantity is False
    non_integer = [trade for trade in result.executedTrades if not math.isclose(trade.positionSize, round(trade.positionSize), abs_tol=1e-6)]
    assert non_integer, "Expected at least one trade with fractional size when rounding is disabled"


def test_round_quantity_skips_entries_below_lot():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        lot_size=10_000.0,
        round_quantity=True,
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
        ),
    )

    result = run_backtest(db, request)

    assert result.numberOfTrades == 0
    assert math.isclose(result.lot_size, request.lot_size)
    assert result.round_quantity is True


def test_round_quantity_applies_to_shorts():
    db = _setup_session()
    _seed_candles(db)

    request = BacktestRequest(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol="BTCUSDT",
        timeframe="1h",
        lot_size=1.0,
        round_quantity=True,
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
            allowShort=True,
        ),
    )

    result = run_backtest(db, request)

    short_trades = [trade for trade in result.executedTrades if trade.direction == "short"]
    assert math.isclose(result.lot_size, request.lot_size)
    assert result.round_quantity is True
    assert short_trades, "Expected at least one short trade"
    for trade in short_trades:
        remainder = math.fmod(trade.positionSize, request.lot_size)
        assert math.isclose(remainder, 0.0, abs_tol=1e-8) or math.isclose(remainder, request.lot_size, abs_tol=1e-8)


def test_close_and_record_trade_marks_breakeven_when_profit_zero():
    trades = []
    position = Position(
        entry_time=datetime(2024, 1, 1),
        entry_price=100.0,
        quantity=1.0,
        direction=1,
        entry_fee=0.0,
        entry_signal="Test entry",
    )

    cash, wins, losses, breakevens, cumulative_profit = _close_and_record_trade(
        position,
        price=100.0,
        fee_rate=0.0,
        timestamp=datetime(2024, 1, 2),
        exit_signal="Test exit",
        trades=trades,
        cash=0.0,
        wins=0,
        losses=0,
        breakevens=0,
        cumulative_profit=0.0,
    )

    assert math.isclose(cash, 100.0)
    assert wins == 0
    assert losses == 0
    assert breakevens == 1
    assert math.isclose(cumulative_profit, 0.0)
    assert trades and math.isclose(trades[0].profit, 0.0)


def test_execution_model_controls_execution_price():
    db = _setup_session()
    symbol = "SPREAD"
    _seed_candles_with_spread(db, symbol)

    base_request = dict(
        initialCapital=1_000.0,
        tradingFee=0.1,
        symbol=symbol,
        timeframe="1h",
        strategyRules=MovingAverageCrossStrategy(
            type="moving_average_cross",
            fastWindow=2,
            slowWindow=4,
            allowShort=True,
        ),
    )

    close_result = run_backtest(
        db,
        BacktestRequest(**base_request, execution_model="close_signal_bar"),
    )
    open_result = run_backtest(
        db,
        BacktestRequest(**base_request, execution_model="open_next_bar"),
    )

    assert close_result.execution_model == "close_signal_bar"
    assert open_result.execution_model == "open_next_bar"
    assert close_result.executedTrades, "Expected trades for execution model comparison"
    assert len(close_result.executedTrades) == len(open_result.executedTrades)

    close_lookup = {candle.timestamp: candle for candle in close_result.annotatedCandles}
    open_lookup = {candle.timestamp: candle for candle in open_result.annotatedCandles}

    for trade in close_result.executedTrades:
        assert trade.entryTime in close_lookup
        entry_candle = close_lookup[trade.entryTime]
        assert math.isclose(trade.entryPrice, entry_candle.close, rel_tol=1e-9, abs_tol=1e-9)
        if trade.exitSignal != "Final bar exit":
            assert trade.exitTime in close_lookup
            exit_candle = close_lookup[trade.exitTime]
            assert math.isclose(trade.exitPrice, exit_candle.close, rel_tol=1e-9, abs_tol=1e-9)

    for trade in open_result.executedTrades:
        assert trade.entryTime in open_lookup
        entry_candle = open_lookup[trade.entryTime]
        assert math.isclose(trade.entryPrice, entry_candle.open, rel_tol=1e-9, abs_tol=1e-9)
        if trade.exitSignal != "Final bar exit":
            assert trade.exitTime in open_lookup
            exit_candle = open_lookup[trade.exitTime]
            assert math.isclose(trade.exitPrice, exit_candle.open, rel_tol=1e-9, abs_tol=1e-9)
