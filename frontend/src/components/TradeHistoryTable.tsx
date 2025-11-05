import { useCallback, useMemo, useState } from "react";

import { TradeResult } from "../api/types";

const SIGNAL_SHORT_LABELS: Record<string, string> = {
  "price broke above upper band": "Upper Break",
  "price crossed above upper band": "Upper Cross",
  "price broke below lower band": "Lower Break",
  "price crossed below lower band": "Lower Cross",
  "price broke above upper band (retest)": "Upper Retest",
  "price broke below lower band (retest)": "Lower Retest",
  "fast ma crossed above slow ma": "MA Cross ↑",
  "fast ma crossed below slow ma": "MA Cross ↓",
};

type Props = {
  trades: TradeResult[];
  onJumpToTrade?: (trade: TradeResult) => void;
};

type EnrichedTrade = TradeResult & {
  index: number;
  returnPercent: number;
  durationMs: number;
  durationLabel: string;
  entryParts: { date: string; time?: string };
  exitParts: { date: string; time?: string };
  entrySignalShort: string;
  entrySignalFull: string;
  exitSignalShort: string;
  exitSignalFull: string;
};

type SortKey =
  | "entryTime"
  | "exitTime"
  | "direction"
  | "entrySignal"
  | "exitSignal"
  | "positionSize"
  | "profit"
  | "runUp"
  | "drawDown"
  | "cumulativeProfit"
  | "returnPercent"
  | "durationMs";

type Header = {
  key: SortKey | "index" | "price" | "signals";
  label: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
};

type SortOrder = "asc" | "desc";

const headers: Header[] = [
  { key: "index", label: "Trade", align: "center", sortable: false },
  { key: "entryTime", label: "Entry Time" },
  { key: "exitTime", label: "Exit Time" },
  { key: "direction", label: "Side", align: "center" },
  { key: "signals", label: "Entry / Exit Signals", sortable: false },
  { key: "price", label: "Entry / Exit Price", align: "right", sortable: false },
  { key: "positionSize", label: "Size (Qty)", align: "right" },
  { key: "durationMs", label: "Duration", align: "right" },
  { key: "returnPercent", label: "Return %", align: "right" },
  { key: "profit", label: "Net P&L", align: "right" },
  { key: "runUp", label: "Run-up", align: "right" },
  { key: "drawDown", label: "Drawdown", align: "right" },
  { key: "cumulativeProfit", label: "Cum. P&L", align: "right" },
];

const TradeHistoryTable = ({ trades, onJumpToTrade }: Props) => {
  const [sortKey, setSortKey] = useState<SortKey>("entryTime");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "2-digit",
      }),
    [],
  );

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [],
  );

  const formatDateParts = useCallback(
    (value: string): { date: string; time?: string } => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return { date: value };
      }
      return {
        date: dateFormatter.format(date),
        time: `${timeFormatter.format(date)} UTC`,
      };
    },
    [dateFormatter, timeFormatter],
  );

  const formatCurrency = useCallback(
    (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [],
  );

  const formatSignedCurrency = useCallback((value: number) => {
    if (Object.is(value, -0)) {
      return "0.00";
    }
    if (value === 0) {
      return "0.00";
    }
    const absFormatted = Math.abs(value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${value > 0 ? "+" : "-"}${absFormatted}`;
  }, []);

  const formatSize = useCallback(
    (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 }),
    [],
  );

  const formatDuration = useCallback((milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return "—";
    }
    const totalMinutes = Math.trunc(milliseconds / 60000);
    if (totalMinutes <= 1) {
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
  }, []);

  const formatSignedPercent = useCallback((value: number) => {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return "0.00%";
    }
    if (value === 0) {
      return "0.00%";
    }
    const abs = Math.abs(value).toFixed(2);
    return `${value > 0 ? "+" : "-"}${abs}%`;
  }, []);

  const formatSignal = useCallback((value: string): { short: string; full: string } => {
    if (!value) {
      return { short: "—", full: "—" };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { short: "—", full: "—" };
    }
    const normalized = trimmed.toLowerCase();
    const match = SIGNAL_SHORT_LABELS[normalized];
    if (match) {
      return { short: match, full: trimmed };
    }
    if (trimmed.length <= 22) {
      return { short: trimmed, full: trimmed };
    }
    return { short: `${trimmed.slice(0, 19)}…`, full: trimmed };
  }, []);

  const enrichedTrades = useMemo<EnrichedTrade[]>(() => {
    return trades.map((trade, index) => {
      const entryParts = formatDateParts(trade.entryTime);
      const exitParts = formatDateParts(trade.exitTime);
      const entryDate = new Date(trade.entryTime);
      const exitDate = new Date(trade.exitTime);
      const durationMs = Number.isNaN(entryDate.getTime()) || Number.isNaN(exitDate.getTime())
        ? 0
        : Math.max(exitDate.getTime() - entryDate.getTime(), 0);
      const notional = trade.entryPrice * trade.positionSize;
      const returnPercent = notional !== 0 ? (trade.profit / notional) * 100 : 0;
      const entrySignal = formatSignal(trade.entrySignal);
      const exitSignal = formatSignal(trade.exitSignal);

      return {
        ...trade,
        index: index + 1,
        entryParts,
        exitParts,
        durationMs,
        durationLabel: formatDuration(durationMs),
        returnPercent,
        entrySignalShort: entrySignal.short,
        entrySignalFull: entrySignal.full,
        exitSignalShort: exitSignal.short,
        exitSignalFull: exitSignal.full,
      };
    });
  }, [trades, formatDateParts, formatDuration, formatSignal]);

  const sortedTrades = useMemo<EnrichedTrade[]>(() => {
    const cloned = [...enrichedTrades];
    cloned.sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (typeof aValue === "number" && typeof bValue === "number") {
        return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
      }
      const aStr = String(aValue ?? "");
      const bStr = String(bValue ?? "");
      return sortOrder === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
    return cloned;
  }, [enrichedTrades, sortKey, sortOrder]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortOrder((prev: SortOrder) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  if (trades.length === 0) {
    return (
      <div className="trade-table empty">
        <p>No trades executed for this configuration.</p>
      </div>
    );
  }

  return (
    <div className="trade-table">
      <table>
        <thead>
          <tr>
            {headers.map(({ key, label, align, sortable = true }) => {
              const isSortable = sortable && key !== "index";
              const isActive = isSortable && sortKey === key;
              const classNames = [align ? `align-${align}` : undefined, isSortable ? "sortable" : "unsortable", isActive ? "active" : undefined]
                .filter(Boolean)
                .join(" ");
              return (
                <th
                  key={key}
                  className={classNames || undefined}
                  onClick={isSortable ? () => onSort(key as SortKey) : undefined}
                  role={isSortable ? "button" : undefined}
                  tabIndex={isSortable ? 0 : -1}
                  onKeyDown={
                    isSortable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSort(key as SortKey);
                          }
                        }
                      : undefined
                  }
                >
                  {label}
                  {isActive ? (sortOrder === "asc" ? " ↑" : " ↓") : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedTrades.map((trade) => (
            <tr
              key={`${trade.entryTime}-${trade.exitTime}-${trade.index}`}
              className={`trade-row ${trade.profit > 0 ? "positive" : trade.profit < 0 ? "negative" : "flat"}`}
            >
              <td className="align-center index-cell">
                <button
                  type="button"
                  className="jump-button"
                  aria-label={`Jump to chart for trade #${trade.index}`}
                  onClick={() => {
                    if (onJumpToTrade) {
                      onJumpToTrade(trade);
                    }
                  }}
                  title="View this trade on the price chart"
                  disabled={!onJumpToTrade}
                >
                  <span aria-hidden="true" className="jump-icon">⤴</span>
                  <span aria-hidden="true" className="jump-badge">#{trade.index}</span>
                </button>
              </td>
              <td>
                <div className="datetime-cell">
                  <span className="date">{trade.entryParts.date}</span>
                  {trade.entryParts.time && <span className="time">{trade.entryParts.time}</span>}
                </div>
              </td>
              <td>
                <div className="datetime-cell">
                  <span className="date">{trade.exitParts.date}</span>
                  {trade.exitParts.time && <span className="time">{trade.exitParts.time}</span>}
                </div>
              </td>
              <td className="align-center">
                <span className={`direction-pill ${trade.direction}`}>
                  {trade.direction === "long" ? "Long" : "Short"}
                </span>
              </td>
              <td className="signal-cell">
                <div className="signal-line entry" title={trade.entrySignalFull}>
                  <span className="label">Entry</span>
                  <span className="value signal-badge entry">{trade.entrySignalShort}</span>
                </div>
                <div className="signal-line exit" title={trade.exitSignalFull}>
                  <span className="label">Exit</span>
                  <span className="value signal-badge exit">{trade.exitSignalShort}</span>
                </div>
              </td>
              <td className="align-right price-cell" title="Prices reflect filled entry and exit levels (exclusive of fees)">
                <div className="price-line entry">
                  <span className="label">Entry</span>
                  <span className="value">{formatCurrency(trade.entryPrice)}</span>
                </div>
                <div className="price-line exit">
                  <span className="label">Exit</span>
                  <span className="value">{formatCurrency(trade.exitPrice)}</span>
                </div>
              </td>
              <td className="align-right">{formatSize(trade.positionSize)}</td>
              <td className="align-right duration-cell">{trade.durationLabel}</td>
              <td className={`align-right ${trade.returnPercent >= 0 ? "profit" : "loss"}`}>
                {formatSignedPercent(trade.returnPercent)}
              </td>
              <td className={`align-right ${trade.profit >= 0 ? "profit" : "loss"}`}>
                {formatSignedCurrency(trade.profit)}
              </td>
              <td className={`align-right ${trade.runUp >= 0 ? "profit" : "loss"}`}>
                {formatSignedCurrency(trade.runUp)}
              </td>
              <td className={`align-right ${trade.drawDown >= 0 ? "profit" : "loss"}`}>
                {formatSignedCurrency(trade.drawDown)}
              </td>
              <td className={`align-right ${trade.cumulativeProfit >= 0 ? "profit" : "loss"}`}>
                {formatSignedCurrency(trade.cumulativeProfit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default TradeHistoryTable;
