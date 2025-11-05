from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple, Union

from sqlalchemy.orm import Session  # type: ignore[import]

from ..models import PriceCandle
from ..schemas import (
    AnnotatedCandle,
    BacktestRequest,
    BacktestResponse,
    EquityPoint,
    IndicatorPoint,
    MovingAverageCrossStrategy,
    StrategyRules,
    TradeResult,
)
from .pine_parser import KemaOptionConfig, PineScriptParseError, parse_pine_script


@dataclass
class Position:
    entry_time: datetime
    entry_price: float
    quantity: float
    direction: int  # 1 = long, -1 = short
    entry_fee: float
    entry_signal: str
    max_favorable: float = 0.0
    max_adverse: float = 0.0


def _ensure_utc_datetime(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _resolve_strategy(rules: StrategyRules) -> Union[MovingAverageCrossStrategy, KemaOptionConfig]:
    if isinstance(rules, MovingAverageCrossStrategy):
        return rules
    if rules.type == "pine_script":
        try:
            return parse_pine_script(rules.code)
        except PineScriptParseError as exc:
            raise ValueError(str(exc)) from exc
    raise ValueError("Unsupported strategy type")


def _fetch_candles(db: Session, req: BacktestRequest) -> List[PriceCandle]:
    query = (
        db.query(PriceCandle)
        .filter(PriceCandle.symbol == req.symbol)
        .filter(PriceCandle.timeframe == req.timeframe)
        .order_by(PriceCandle.timestamp.asc())
    )

    if req.startTime:
        query = query.filter(PriceCandle.timestamp >= req.startTime)
    if req.endTime:
        query = query.filter(PriceCandle.timestamp <= req.endTime)

    candles = query.all()
    if not candles:
        raise ValueError("No candles found for the specified symbol/timeframe range")
    for candle in candles:
        candle.timestamp = _ensure_utc_datetime(candle.timestamp)
    return candles


def _moving_average(series: List[float], window: int) -> Optional[float]:
    if len(series) < window:
        return None
    return sum(series[-window:]) / window


def _update_drawdown(max_equity: float, equity: float, drawdown: float) -> Tuple[float, float]:
    if equity > max_equity:
        max_equity = equity
    if max_equity > 0:
        drawdown = max(drawdown, (max_equity - equity) / max_equity * 100)
    return max_equity, drawdown


def _ema(previous: Optional[float], value: float, length: int) -> float:
    # Exponential moving average: EMA_t = α * price_t + (1 - α) * EMA_{t-1}, where α = 2 / (length + 1).
    # When no previous seed is available we fall back to the raw price so callers can bootstrap with an SMA.
    if length <= 1 or previous is None:
        return value
    alpha = 2 / (length + 1)
    return alpha * value + (1 - alpha) * previous


def _true_range(high: float, low: float, prev_close: Optional[float]) -> float:
    # True range follows Wilder's definition: max(high - low, |high - prev_close|, |low - prev_close|).
    # If there is no previous close we simply use the intrabar range.
    if prev_close is None:
        return high - low
    return max(high - low, abs(high - prev_close), abs(low - prev_close))


def _quantize_contracts(quantity: float) -> float:
    if quantity <= 0:
        return 0.0
    return math.floor(quantity * 10000) / 10000.0


def _compute_contracts(
    strategy: KemaOptionConfig,
    equity: float,
    channel_delta: Optional[float],
    atr_value: Optional[float],
    price: float,
) -> float:
    if price <= 0 or equity <= 0:
        return 0.0
    if channel_delta is None or channel_delta <= 0 or atr_value is None or atr_value <= 0:
        return 0.0

    initial_risk_amount = strategy.initial_risk * equity
    equity_risk_amount = strategy.risk_equity * equity

    if initial_risk_amount <= 0 or equity_risk_amount <= 0:
        return 0.0

    qty_from_delta = initial_risk_amount / channel_delta
    qty_from_atr = initial_risk_amount / atr_value
    qty_from_equity = equity_risk_amount / price

    quantity = min(qty_from_delta, qty_from_atr, qty_from_equity)
    if not math.isfinite(quantity):
        return 0.0001
    quantity = max(quantity, 0.0)
    quantized = _quantize_contracts(quantity)
    if quantized <= 0:
        return 0.0001
    return max(quantized, 0.0001)


def _close_position(
    position: Position,
    price: float,
    fee_rate: float,
) -> Tuple[float, float, float, str]:
    if position.direction == 1:
        gross = position.quantity * price
        exit_fee = gross * fee_rate
        proceeds = gross - exit_fee
        cash_delta = proceeds
        profit = (
            (price - position.entry_price) * position.quantity
            - position.entry_fee
            - exit_fee
        )
        direction_label = "long"
    else:
        buyback = position.quantity * price
        exit_fee = buyback * fee_rate
        cash_delta = -(buyback + exit_fee)
        profit = (
            (position.entry_price - price) * position.quantity
            - position.entry_fee
            - exit_fee
        )
        direction_label = "short"
    return cash_delta, profit, exit_fee, direction_label


def _close_and_record_trade(
    position: Position,
    price: float,
    fee_rate: float,
    timestamp: datetime,
    exit_signal: str,
    trades: List[TradeResult],
    cash: float,
    wins: int,
    losses: int,
    cumulative_profit: float,
) -> Tuple[float, int, int, float]:
    cash_delta, profit, exit_fee, direction_label = _close_position(position, price, fee_rate)
    cash += cash_delta

    realized_run_up = max(position.max_favorable, profit)
    realized_drawdown = min(position.max_adverse, profit)

    cumulative_profit += profit

    trades.append(
        TradeResult(
            entryTime=position.entry_time,
            exitTime=timestamp,
            entryPrice=position.entry_price,
            exitPrice=price,
            profit=profit,
            direction=direction_label,
            entrySignal=position.entry_signal,
            exitSignal=exit_signal,
            positionSize=position.quantity,
            runUp=realized_run_up,
            drawDown=realized_drawdown,
            cumulativeProfit=cumulative_profit,
        )
    )

    if profit >= 0:
        wins += 1
    else:
        losses += 1

    return cash, wins, losses, cumulative_profit


def _current_equity(cash: float, position: Optional[Position], price: float) -> float:
    equity = cash
    if position is not None:
        equity += position.direction * position.quantity * price
    return equity


def _run_ma_cross(
    candles: List[PriceCandle],
    strategy: MovingAverageCrossStrategy,
    req: BacktestRequest,
) -> BacktestResponse:
    fast_window = strategy.fastWindow
    slow_window = strategy.slowWindow
    fee_rate = req.tradingFee / 100.0

    fast_history: List[float] = []
    slow_history: List[float] = []

    position: Optional[Position] = None
    cash = req.initialCapital
    equity_curve: List[EquityPoint] = []
    trades: List[TradeResult] = []
    max_equity = req.initialCapital
    max_drawdown = 0.0
    wins = 0
    losses = 0
    cumulative_profit = 0.0

    pending_entry_direction: Optional[int] = None
    pending_entry_signal: Optional[str] = None
    pending_exit_direction: Optional[int] = None
    pending_exit_signal: Optional[str] = None

    prev_fast_ma: Optional[float] = None
    prev_slow_ma: Optional[float] = None

    indicator_values: Dict[str, List[Tuple[datetime, float]]] = {
        "Fast MA": [],
        "Slow MA": [],
    }
    annotated_candles: List[AnnotatedCandle] = []

    for candle in candles:
        price = getattr(candle, strategy.source)
        execution_price = candle.open
        high = candle.high
        low = candle.low

        if pending_exit_direction is not None and position is not None:
            if position.direction == pending_exit_direction:
                cash, wins, losses, cumulative_profit = _close_and_record_trade(
                    position,
                    execution_price,
                    fee_rate,
                    candle.timestamp,
                    pending_exit_signal or "Exit signal",
                    trades,
                    cash,
                    wins,
                    losses,
                    cumulative_profit,
                )
                position = None
            pending_exit_direction = None
            pending_exit_signal = None

        if pending_entry_direction is not None and position is None and execution_price > 0:
            entry_signal = pending_entry_signal or (
                "Fast MA crossover" if pending_entry_direction == 1 else "Fast MA crossunder"
            )
            if pending_entry_direction == 1:
                if cash > 0:
                    original_cash = cash
                    entry_fee = cash * fee_rate
                    cash -= entry_fee
                    if cash > 0:
                        quantity = cash / execution_price
                        if quantity > 0:
                            cash -= quantity * execution_price
                            position = Position(
                                entry_time=candle.timestamp,
                                entry_price=execution_price,
                                quantity=quantity,
                                direction=1,
                                entry_fee=entry_fee,
                                entry_signal=entry_signal,
                            )
                        else:
                            cash = original_cash
                    else:
                        cash = original_cash
            elif pending_entry_direction == -1 and strategy.allowShort and cash > 0:
                original_cash = cash
                entry_fee = cash * fee_rate
                cash -= entry_fee
                if execution_price > 0:
                    quantity = original_cash / execution_price
                else:
                    quantity = 0.0
                if cash > 0 and quantity > 0:
                    cash += original_cash
                    position = Position(
                        entry_time=candle.timestamp,
                        entry_price=execution_price,
                        quantity=quantity,
                        direction=-1,
                        entry_fee=entry_fee,
                        entry_signal=entry_signal,
                    )
                else:
                    cash = original_cash
            pending_entry_direction = None
            pending_entry_signal = None

        fast_history.append(price)
        slow_history.append(price)

        fast_ma = _moving_average(fast_history, fast_window)
        slow_ma = _moving_average(slow_history, slow_window)

        if fast_ma is not None:
            indicator_values["Fast MA"].append((candle.timestamp, fast_ma))
        if slow_ma is not None:
            indicator_values["Slow MA"].append((candle.timestamp, slow_ma))

        signal_buy = False
        signal_sell = False
        entry_signal_text = "Fast MA crossed above Slow MA"
        exit_signal_text = "Fast MA crossed below Slow MA"

        if fast_ma is not None and slow_ma is not None:
            if prev_fast_ma is not None and prev_slow_ma is not None:
                # Cross above: previous fast MA at or below slow MA and current fast MA strictly greater than slow MA.
                if prev_fast_ma <= prev_slow_ma and fast_ma > slow_ma:
                    signal_buy = True
                    entry_signal_text = "Fast MA crossed above Slow MA"
                    exit_signal_text = entry_signal_text
                # Cross below: mirror condition for fast MA dropping under the slow MA.
                elif prev_fast_ma >= prev_slow_ma and fast_ma < slow_ma:
                    signal_sell = True
                    exit_signal_text = "Fast MA crossed below Slow MA"
                    entry_signal_text = exit_signal_text
            prev_fast_ma = fast_ma
            prev_slow_ma = slow_ma

        if signal_buy:
            if position is None:
                pending_entry_direction = 1
                pending_entry_signal = entry_signal_text
            elif position.direction == -1:
                pending_exit_direction = -1
                pending_exit_signal = entry_signal_text
                pending_entry_direction = 1
                pending_entry_signal = entry_signal_text
        elif signal_sell:
            if position is not None and position.direction == 1:
                pending_exit_direction = 1
                pending_exit_signal = exit_signal_text
                if strategy.allowShort:
                    pending_entry_direction = -1
                    pending_entry_signal = exit_signal_text
            elif position is None and strategy.allowShort:
                pending_entry_direction = -1
                pending_entry_signal = exit_signal_text

        if position is not None:
            if position.direction == 1:
                favorable = (high - position.entry_price) * position.quantity - position.entry_fee
                adverse = (low - position.entry_price) * position.quantity - position.entry_fee
            else:
                favorable = (position.entry_price - low) * position.quantity - position.entry_fee
                adverse = (position.entry_price - high) * position.quantity - position.entry_fee
            position.max_favorable = max(position.max_favorable, favorable)
            position.max_adverse = min(position.max_adverse, adverse)

        equity = _current_equity(cash, position, price)
        equity_curve.append(EquityPoint(timestamp=candle.timestamp, equity=equity))
        max_equity, max_drawdown = _update_drawdown(max_equity, equity, max_drawdown)

        indicator_snapshot = {
            "Fast MA": fast_ma if fast_ma is not None else None,
            "Slow MA": slow_ma if slow_ma is not None else None,
        }
        annotated_candles.append(
            AnnotatedCandle(
                timestamp=candle.timestamp,
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                volume=candle.volume,
                indicators=indicator_snapshot,
            )
        )

    if position is not None:
        last_price = getattr(candles[-1], strategy.source)
        cash, wins, losses, cumulative_profit = _close_and_record_trade(
            position,
            last_price,
            fee_rate,
            candles[-1].timestamp,
            "Final bar exit",
            trades,
            cash,
            wins,
            losses,
            cumulative_profit,
        )
        position = None
        equity = cash
        equity_curve.append(EquityPoint(timestamp=candles[-1].timestamp, equity=equity))
        max_equity, max_drawdown = _update_drawdown(max_equity, equity, max_drawdown)

    total_profit = equity_curve[-1].equity - req.initialCapital if equity_curve else 0.0
    roi_percent = (total_profit / req.initialCapital * 100) if req.initialCapital else 0.0
    total_trades = len(trades)
    winrate = (wins / total_trades * 100) if total_trades else 0.0

    return BacktestResponse(
        totalProfit=round(total_profit, 2),
        roiPercent=round(roi_percent, 2),
        maxDrawdown=round(max_drawdown, 2),
        winrate=round(winrate, 2),
        numberOfTrades=total_trades,
        equityCurve=equity_curve,
        executedTrades=trades,
        indicatorLines={
            name: [IndicatorPoint(timestamp=ts, value=value) for ts, value in points]
            for name, points in indicator_values.items()
            if points
        },
        annotatedCandles=annotated_candles,
    )


def _run_kema_option(
    candles: List[PriceCandle],
    strategy: KemaOptionConfig,
    req: BacktestRequest,
) -> BacktestResponse:
    fee_rate = req.tradingFee / 100.0

    position: Optional[Position] = None
    cash = req.initialCapital
    equity_curve: List[EquityPoint] = []
    trades: List[TradeResult] = []
    max_equity = req.initialCapital
    max_drawdown = 0.0
    wins = 0
    losses = 0
    cumulative_profit = 0.0

    pending_entry_direction: Optional[int] = None
    pending_entry_contracts: float = 0.0
    pending_entry_signal: Optional[str] = None
    pending_entry_in_window: bool = True
    pending_exit_direction: Optional[int] = None
    pending_exit_signal: Optional[str] = None

    ema_value: Optional[float] = None
    atr_value: Optional[float] = None
    ema_seed: List[float] = []
    atr_seed: List[float] = []
    prev_close: Optional[float] = None
    prev_upper: Optional[float] = None
    prev_lower: Optional[float] = None
    prev_time: Optional[datetime] = None
    bar_index = 0
    warmup_bars = max(strategy.ema_length, strategy.atr_length)

    indicator_values: Dict[str, List[Tuple[datetime, float]]] = {
        "EMA": [],
        "Upper Band": [],
        "Lower Band": [],
    }
    annotated_candles: List[AnnotatedCandle] = []

    for candle in candles:
        price = candle.close
        high = candle.high
        low = candle.low
        timestamp = candle.timestamp
        execution_price = candle.open

        bar_in_window = True
        if strategy.start_date and timestamp < strategy.start_date:
            bar_in_window = False
        if strategy.end_date and timestamp > strategy.end_date:
            bar_in_window = False

        if pending_exit_direction is not None:
            if position is not None and position.direction == pending_exit_direction:
                exit_price = execution_price if execution_price > 0 else price
                cash, wins, losses, cumulative_profit = _close_and_record_trade(
                    position,
                    exit_price,
                    fee_rate,
                    timestamp,
                    pending_exit_signal or "Exit signal",
                    trades,
                    cash,
                    wins,
                    losses,
                    cumulative_profit,
                )
                position = None
            pending_exit_direction = None
            pending_exit_signal = None

        if (
            pending_entry_direction is not None
            and position is None
            and pending_entry_contracts > 0
            and execution_price > 0
            and pending_entry_in_window
            and bar_in_window
        ):
            if pending_entry_direction == 1 and strategy.trade_option in {"long_only", "both"}:
                affordable = cash / execution_price if execution_price > 0 else 0.0
                quantity = min(pending_entry_contracts, affordable)
                if quantity > 0:
                    entry_cost = quantity * execution_price
                    entry_fee = entry_cost * fee_rate
                    total_cost = entry_cost + entry_fee
                    if total_cost <= cash:
                        cash -= total_cost
                        position = Position(
                            entry_time=timestamp,
                            entry_price=execution_price,
                            quantity=quantity,
                            direction=1,
                            entry_fee=entry_fee,
                            entry_signal=pending_entry_signal or "Upper band breakout",
                        )
            elif pending_entry_direction == -1 and strategy.trade_option in {"short_only", "both"}:
                notional = pending_entry_contracts * execution_price
                if notional > 0:
                    entry_fee = notional * fee_rate
                    if cash >= entry_fee:
                        cash -= entry_fee
                        cash += notional
                        position = Position(
                            entry_time=timestamp,
                            entry_price=execution_price,
                            quantity=pending_entry_contracts,
                            direction=-1,
                            entry_fee=entry_fee,
                            entry_signal=pending_entry_signal or "Lower band breakdown",
                        )
            pending_entry_direction = None
            pending_entry_contracts = 0.0
            pending_entry_signal = None
            pending_entry_in_window = True

        if (
            position is not None
            and strategy.end_date is not None
            and prev_time is not None
            and prev_time <= strategy.end_date < timestamp
        ):
            cash, wins, losses, cumulative_profit = _close_and_record_trade(
                position,
                price,
                fee_rate,
                timestamp,
                "Strategy window expired",
                trades,
                cash,
                wins,
                losses,
                cumulative_profit,
            )
            position = None

        atr_component = _true_range(high, low, prev_close)

        if strategy.ema_length <= 1:
            ema_value = price
        else:
            ema_seed.append(price)
            if len(ema_seed) == strategy.ema_length:
                # Seed EMA with the simple average of the first N closes, matching TradingView's SMA bootstrap.
                ema_value = sum(ema_seed[-strategy.ema_length:]) / strategy.ema_length
            elif len(ema_seed) > strategy.ema_length and ema_value is not None:
                # After seeding we keep applying the EMA recursion EMA_t = α * price_t + (1 - α) * EMA_{t-1}.
                ema_value = _ema(ema_value, price, strategy.ema_length)

        if strategy.atr_length <= 1:
            atr_value = atr_component
        else:
            atr_seed.append(atr_component)
            seed_length = strategy.atr_length
            if len(atr_seed) == seed_length:
                # ATR uses the SMA seed on true range values before switching to the EMA recursion.
                atr_value = sum(atr_seed[-seed_length:]) / seed_length
            elif len(atr_seed) > seed_length and atr_value is not None:
                # Standard ATR: ATR_t = EMA(TrueRange_t, length) once the SMA seed is established.
                atr_value = _ema(atr_value, atr_component, seed_length)

        upper_band: Optional[float] = None
        lower_band: Optional[float] = None
        if ema_value is not None and atr_value is not None:
            # Keltner-style channel: upper = EMA + k * ATR, lower = EMA - k * ATR.
            upper_band = ema_value + strategy.volatility_factor * atr_value
            lower_band = ema_value - strategy.volatility_factor * atr_value
        warmup_complete = bar_index + 1 >= warmup_bars
        current_upper_band = upper_band if warmup_complete else None
        current_lower_band = lower_band if warmup_complete else None
        if (
            warmup_complete
            and ema_value is not None
            and atr_value is not None
            and current_upper_band is not None
            and current_lower_band is not None
        ):
            indicator_values["EMA"].append((timestamp, ema_value))
            indicator_values["Upper Band"].append((timestamp, current_upper_band))
            indicator_values["Lower Band"].append((timestamp, current_lower_band))

        long_exit = (
            position is not None
            and position.direction == 1
            and prev_close is not None
            and prev_lower is not None
            and current_lower_band is not None
            and prev_close >= prev_lower
            and price < current_lower_band
        )

        short_exit = (
            position is not None
            and position.direction == -1
            and prev_close is not None
            and prev_upper is not None
            and current_upper_band is not None
            and prev_close <= prev_upper
            and price > current_upper_band
        )

        in_window = bar_in_window

        channel_delta = None
        if current_upper_band is not None and current_lower_band is not None:
            channel_delta = current_upper_band - current_lower_band

        long_entry = (
            prev_close is not None
            and prev_upper is not None
            and current_upper_band is not None
            and prev_close <= prev_upper
            and price > current_upper_band
            and in_window
            and strategy.trade_option in {"long_only", "both"}
        )

        short_entry = (
            prev_close is not None
            and prev_lower is not None
            and current_lower_band is not None
            and prev_close >= prev_lower
            and price < current_lower_band
            and in_window
            and strategy.trade_option in {"short_only", "both"}
        )

        if position is not None and pending_exit_direction is None:
            if long_exit and position.direction == 1:
                pending_exit_direction = 1
                pending_exit_signal = "Price crossed below lower band"
            elif short_exit and position.direction == -1:
                pending_exit_direction = -1
                pending_exit_signal = "Price crossed above upper band"
            elif long_entry and position.direction == -1:
                pending_exit_direction = -1
                pending_exit_signal = "Price crossed above upper band"
            elif short_entry and position.direction == 1:
                pending_exit_direction = 1
                pending_exit_signal = "Price crossed below lower band"

        def _schedule_entry(direction: int, signal: str) -> None:
            nonlocal pending_entry_direction, pending_entry_contracts, pending_entry_signal, pending_entry_in_window
            if (
                not warmup_complete
                or channel_delta is None
                or channel_delta <= 0
                or atr_value is None
                or atr_value <= 0
                or price <= 0
            ):
                return
            if position is not None and position.direction == direction:
                return
            if direction == 1 and strategy.trade_option not in {"long_only", "both"}:
                return
            if direction == -1 and strategy.trade_option not in {"short_only", "both"}:
                return
            if pending_entry_direction is not None:
                return
            equity_snapshot = _current_equity(cash, position, price)
            desired_contracts = _compute_contracts(
                strategy,
                equity_snapshot,
                channel_delta,
                atr_value,
                price,
            )
            if desired_contracts <= 0:
                return
            pending_entry_direction = direction
            pending_entry_contracts = desired_contracts
            pending_entry_signal = signal
            pending_entry_in_window = in_window

        if long_entry:
            _schedule_entry(1, "Price broke above upper band")
        elif short_entry:
            _schedule_entry(-1, "Price broke below lower band")

        if position is not None:
            if position.direction == 1:
                favorable = (high - position.entry_price) * position.quantity - position.entry_fee
                adverse = (low - position.entry_price) * position.quantity - position.entry_fee
            else:
                favorable = (position.entry_price - low) * position.quantity - position.entry_fee
                adverse = (position.entry_price - high) * position.quantity - position.entry_fee
            position.max_favorable = max(position.max_favorable, favorable)
            position.max_adverse = min(position.max_adverse, adverse)

        equity = _current_equity(cash, position, price)
        equity_curve.append(EquityPoint(timestamp=timestamp, equity=equity))
        max_equity, max_drawdown = _update_drawdown(max_equity, equity, max_drawdown)

        indicator_snapshot = {
            "EMA": ema_value if warmup_complete and ema_value is not None else None,
            "Upper Band": current_upper_band,
            "Lower Band": current_lower_band,
        }
        annotated_candles.append(
            AnnotatedCandle(
                timestamp=timestamp,
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                volume=candle.volume,
                indicators=indicator_snapshot,
            )
        )

        prev_close = price
        prev_upper = current_upper_band
        prev_lower = current_lower_band
        prev_time = timestamp
        bar_index += 1

    if position is not None:
        last_price = candles[-1].close
        cash, wins, losses, cumulative_profit = _close_and_record_trade(
            position,
            last_price,
            fee_rate,
            candles[-1].timestamp,
            "Final bar exit",
            trades,
            cash,
            wins,
            losses,
            cumulative_profit,
        )
        position = None
        equity = cash
        equity_curve.append(EquityPoint(timestamp=candles[-1].timestamp, equity=equity))
        max_equity, max_drawdown = _update_drawdown(max_equity, equity, max_drawdown)

    total_profit = equity_curve[-1].equity - req.initialCapital if equity_curve else 0.0
    roi_percent = (total_profit / req.initialCapital * 100) if req.initialCapital else 0.0
    total_trades = len(trades)
    winrate = (wins / total_trades * 100) if total_trades else 0.0

    return BacktestResponse(
        totalProfit=round(total_profit, 2),
        roiPercent=round(roi_percent, 2),
        maxDrawdown=round(max_drawdown, 2),
        winrate=round(winrate, 2),
        numberOfTrades=total_trades,
        equityCurve=equity_curve,
        executedTrades=trades,
        indicatorLines={
            name: [IndicatorPoint(timestamp=ts, value=value) for ts, value in points]
            for name, points in indicator_values.items()
            if points
        },
        annotatedCandles=annotated_candles,
    )


def run_backtest(db: Session, req: BacktestRequest) -> BacktestResponse:
    candles = _fetch_candles(db, req)
    strategy = _resolve_strategy(req.strategyRules)

    if isinstance(strategy, MovingAverageCrossStrategy):
        return _run_ma_cross(candles, strategy, req)
    if isinstance(strategy, KemaOptionConfig):
        return _run_kema_option(candles, strategy, req)

    raise ValueError("Unsupported strategy configuration")
