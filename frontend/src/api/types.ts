export interface PriceCandle {
  id: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  symbol: string;
  timeframe: string;
}

export interface DatasetListItem {
  symbol: string;
  timeframe: string;
  earliest: string | null;
  latest: string | null;
  candles: number;
}

export interface TradeResult {
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  profit: number;
  direction: "long" | "short";
  entrySignal: string;
  exitSignal: string;
  positionSize: number;
  runUp: number;
  drawDown: number;
  cumulativeProfit: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
}

export interface IndicatorPoint {
  timestamp: string;
  value: number;
}

export interface BacktestResponse {
  totalProfit: number;
  roiPercent: number;
  maxDrawdown: number;
  winrate: number;
  numberOfTrades: number;
  equityCurve: EquityPoint[];
  executedTrades: TradeResult[];
  indicatorLines: Record<string, IndicatorPoint[]>;
}

export type StrategyType = "moving_average_cross" | "pine_script";

export interface MovingAverageCrossStrategy {
  type: "moving_average_cross";
  fastWindow: number;
  slowWindow: number;
  source: "close" | "open";
  allowShort: boolean;
}

export interface PineScriptStrategy {
  type: "pine_script";
  code: string;
}

export type StrategyRules = MovingAverageCrossStrategy | PineScriptStrategy;

export interface BacktestRequestPayload {
  initialCapital: number;
  tradingFee: number;
  symbol: string;
  timeframe: string;
  strategyRules: StrategyRules;
  startTime?: string;
  endTime?: string;
}
