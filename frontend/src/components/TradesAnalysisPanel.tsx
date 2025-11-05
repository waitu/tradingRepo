import { useMemo } from "react";

import { TradeResult } from "../api/types";

type Props = {
  trades: TradeResult[];
};

type DurationStats = {
  averageMs: number;
  longestMs: number;
  shortestMs: number;
};

type TradeAggregates = {
  total: number;
  longs: number;
  shorts: number;
  wins: number;
  losses: number;
  breakeven: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  bestTrade: number;
  worstTrade: number;
  bestSymbol?: string;
  worstSymbol?: string;
  averageTrade: number;
  averageWin: number;
  averageLoss: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  averageReturnPercent: number;
  duration: DurationStats;
};

const formatCurrency = (value: number): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatSignedCurrency = (value: number): string => {
  if (Object.is(value, -0)) {
    return "0.00";
  }
  const formatted = formatCurrency(Math.abs(value));
  if (value === 0) {
    return formatted;
  }
  return `${value > 0 ? "+" : "-"}${formatted}`;
};

const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const formatted = Math.abs(value).toFixed(2);
  if (value === 0) {
    return "0.00%";
  }
  return `${value > 0 ? "+" : "-"}${formatted}%`;
};

const formatRatio = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
};

const formatDuration = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "—";
  }
  const totalMinutes = Math.trunc(milliseconds / 60000);
  if (totalMinutes === 0) {
    return "<1m";
  }
  const days = Math.trunc(totalMinutes / 1440);
  const hours = Math.trunc((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 && days === 0) {
    parts.push(`${minutes}m`);
  }
  return parts.join(" ") || "<1m";
};

const computeDurationStats = (trades: TradeResult[]): DurationStats => {
  if (trades.length === 0) {
    return { averageMs: 0, longestMs: 0, shortestMs: 0 };
  }
  const durations = trades
    .map((trade) => {
      const entry = new Date(trade.entryTime).getTime();
      const exit = new Date(trade.exitTime).getTime();
      if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
        return 0;
      }
      return Math.max(exit - entry, 0);
    })
    .filter((duration) => Number.isFinite(duration));

  if (durations.length === 0) {
    return { averageMs: 0, longestMs: 0, shortestMs: 0 };
  }

  const total = durations.reduce((acc, value) => acc + value, 0);
  return {
    averageMs: total / durations.length,
    longestMs: Math.max(...durations),
    shortestMs: Math.min(...durations),
  };
};

const computeAggregates = (trades: TradeResult[]): TradeAggregates => {
  if (trades.length === 0) {
    return {
      total: 0,
      longs: 0,
      shorts: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      netProfit: 0,
      grossProfit: 0,
      grossLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      averageTrade: 0,
      averageWin: 0,
      averageLoss: 0,
      winRate: 0,
      profitFactor: null,
      expectancy: 0,
      averageReturnPercent: 0,
      duration: { averageMs: 0, longestMs: 0, shortestMs: 0 },
    };
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let returnPercentSum = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let longs = 0;
  let shorts = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;
  let bestSymbol: string | undefined;
  let worstSymbol: string | undefined;

  trades.forEach((trade) => {
    const profit = trade.profit;
    if (profit > 0) {
      grossProfit += profit;
      wins += 1;
    } else if (profit < 0) {
      grossLoss += profit;
      losses += 1;
    } else {
      breakeven += 1;
    }

    if (trade.direction === "long") {
      longs += 1;
    } else {
      shorts += 1;
    }

    if (profit > bestTrade) {
      bestTrade = profit;
      bestSymbol = trade.exitSignal || trade.entrySignal || undefined;
    }
    if (profit < worstTrade) {
      worstTrade = profit;
      worstSymbol = trade.exitSignal || trade.entrySignal || undefined;
    }

    const entryNotional = trade.entryPrice * trade.positionSize;
    if (entryNotional > 0) {
      returnPercentSum += (profit / entryNotional) * 100;
    }
  });

  const total = trades.length;
  const netProfit = grossProfit + grossLoss;
  const averageTrade = total ? netProfit / total : 0;
  const averageWin = wins ? grossProfit / wins : 0;
  const averageLoss = losses ? grossLoss / losses : 0;
  const winRate = total ? (wins / total) * 100 : 0;
  const profitFactor = grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null;
  const expectancy = averageTrade;
  const averageReturnPercent = total ? returnPercentSum / total : 0;
  const duration = computeDurationStats(trades);

  return {
    total,
    longs,
    shorts,
    wins,
    losses,
    breakeven,
    netProfit,
    grossProfit,
    grossLoss,
    bestTrade: Number.isFinite(bestTrade) ? bestTrade : 0,
    worstTrade: Number.isFinite(worstTrade) ? worstTrade : 0,
    bestSymbol,
    worstSymbol,
    averageTrade,
    averageWin,
    averageLoss,
    winRate,
    profitFactor,
    expectancy,
    averageReturnPercent,
    duration,
  };
};

const TradesAnalysisPanel = ({ trades }: Props) => {
  const stats = useMemo(() => computeAggregates(trades), [trades]);

  const hasTrades = stats.total > 0;

  return (
    <div className="analysis-card">
      <div className="card-header">
        <h3>Trades Analysis</h3>
        <span>{hasTrades ? `${stats.total} closed trades` : "No closed trades"}</span>
      </div>
      {!hasTrades ? (
        <div className="analysis-empty">Run a backtest to populate trade analytics.</div>
      ) : (
        <>
          <div className="analysis-grid primary">
            <div className="analysis-metric">
              <span className="label">Net Profit</span>
              <span className={`value ${stats.netProfit >= 0 ? "positive" : "negative"}`}>
                {formatSignedCurrency(stats.netProfit)}
              </span>
            </div>
            <div className="analysis-metric">
              <span className="label">Profit Factor</span>
              <span className="value">{formatRatio(stats.profitFactor)}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Win Rate</span>
              <span className="value">{formatPercent(stats.winRate)}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Expectancy</span>
              <span className={`value ${stats.expectancy >= 0 ? "positive" : "negative"}`}>
                {formatSignedCurrency(stats.expectancy)}
              </span>
            </div>
          </div>

          <div className="analysis-grid secondary">
            <div className="analysis-metric">
              <span className="label">Total</span>
              <span className="value strong">{stats.total}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Longs</span>
              <span className="value">{stats.longs}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Shorts</span>
              <span className="value">{stats.shorts}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Wins</span>
              <span className="value positive">{stats.wins}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Losses</span>
              <span className="value negative">{stats.losses}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Breakeven</span>
              <span className="value">{stats.breakeven}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Avg Trade</span>
              <span className={`value ${stats.averageTrade >= 0 ? "positive" : "negative"}`}>
                {formatSignedCurrency(stats.averageTrade)}
              </span>
            </div>
            <div className="analysis-metric">
              <span className="label">Avg Win</span>
              <span className="value positive">{formatSignedCurrency(stats.averageWin)}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Avg Loss</span>
              <span className="value negative">{formatSignedCurrency(stats.averageLoss)}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Avg Return</span>
              <span className={`value ${stats.averageReturnPercent >= 0 ? "positive" : "negative"}`}>
                {formatPercent(stats.averageReturnPercent)}
              </span>
            </div>
            <div className="analysis-metric">
              <span className="label">Avg Hold</span>
              <span className="value">{formatDuration(stats.duration.averageMs)}</span>
            </div>
            <div className="analysis-metric">
              <span className="label">Longest Trade</span>
              <span className="value">{formatDuration(stats.duration.longestMs)}</span>
            </div>
          </div>

          <div className="analysis-detail">
            <div className="analysis-detail-row">
              <span className="label">Best Trade</span>
              <span className="value positive">{formatSignedCurrency(stats.bestTrade)}</span>
              <span className="note">{stats.bestSymbol ?? ""}</span>
            </div>
            <div className="analysis-detail-row">
              <span className="label">Worst Trade</span>
              <span className="value negative">{formatSignedCurrency(stats.worstTrade)}</span>
              <span className="note">{stats.worstSymbol ?? ""}</span>
            </div>
            <div className="analysis-detail-row">
              <span className="label">Gross Profit</span>
              <span className="value positive">{formatCurrency(stats.grossProfit)}</span>
            </div>
            <div className="analysis-detail-row">
              <span className="label">Gross Loss</span>
              <span className="value negative">{formatCurrency(Math.abs(stats.grossLoss))}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default TradesAnalysisPanel;
