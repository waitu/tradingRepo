from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, validator


class CandleBase(BaseModel):
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    symbol: str
    timeframe: str = Field(..., description="Timeframe label, e.g., 1h, 1d")


class PriceCandleCreate(CandleBase):
    pass


class PriceCandleOut(CandleBase):
    id: int

    class Config:
        orm_mode = True


class MovingAverageCrossStrategy(BaseModel):
    type: Literal["moving_average_cross"]
    fastWindow: int = Field(..., gt=0)
    slowWindow: int = Field(..., gt=0)
    source: Literal["close", "open"] = "close"
    allowShort: bool = False

    @validator("slowWindow")
    def validate_window(cls, v, values):
        fast = values.get("fastWindow")
        if fast is not None and v <= fast:
            raise ValueError("slowWindow must be greater than fastWindow")
        return v


class PineScriptStrategy(BaseModel):
    type: Literal["pine_script"]
    code: str = Field(..., description="Raw Pine Script v5 code")


StrategyRules = Union[MovingAverageCrossStrategy, PineScriptStrategy]


class BacktestRequest(BaseModel):
    initialCapital: float = Field(..., gt=0)
    tradingFee: float = Field(0.0, ge=0)
    symbol: str
    timeframe: str
    strategyRules: StrategyRules
    startTime: Optional[datetime] = Field(None, description="Optional starting timestamp")
    endTime: Optional[datetime] = Field(None, description="Optional ending timestamp")


class TradeResult(BaseModel):
    entryTime: datetime
    exitTime: datetime
    entryPrice: float
    exitPrice: float
    profit: float
    direction: Literal["long", "short"]
    entrySignal: str
    exitSignal: str
    positionSize: float
    runUp: float
    drawDown: float
    cumulativeProfit: float

    class Config:
        orm_mode = True


class IndicatorPoint(BaseModel):
    timestamp: datetime
    value: float


class EquityPoint(BaseModel):
    timestamp: datetime
    equity: float


class AnnotatedCandle(BaseModel):
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    indicators: Dict[str, Optional[float]] = Field(default_factory=dict)


class BacktestResponse(BaseModel):
    totalProfit: float
    roiPercent: float
    maxDrawdown: float
    winrate: float
    numberOfTrades: int
    equityCurve: List[EquityPoint]
    executedTrades: List[TradeResult]
    indicatorLines: Dict[str, List[IndicatorPoint]] = Field(default_factory=dict)
    annotatedCandles: List[AnnotatedCandle] = Field(default_factory=list)


class DataImportJob(BaseModel):
    symbol: str
    timeframe: str
    recordsImported: int


class DatasetListItem(BaseModel):
    symbol: str
    timeframe: str
    earliest: Optional[datetime]
    latest: Optional[datetime]
    candles: int
