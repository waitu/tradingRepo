from datetime import datetime, timedelta

from sqlalchemy import create_engine  # type: ignore[import]
from sqlalchemy.orm import Session, sessionmaker  # type: ignore[import]

from app.database import Base
from app.models import PriceCandle
from app.schemas import BacktestRequest, MovingAverageCrossStrategy, PineScriptStrategy
from app.services.backtest_engine import run_backtest


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
