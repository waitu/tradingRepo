import { useCallback, useMemo } from "react";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { EquityPoint } from "../api/types";

type Props = {
  data: EquityPoint[];
};

const EquityCurveChart = ({ data }: Props) => {
  const axisDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "2-digit",
      }),
    [],
  );

  const axisDateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [],
  );

  const tooltipDateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [],
  );

  const formatted = useMemo(
    () =>
      data
        .map((point) => {
          const equity = Number(point.equity);
          if (!Number.isFinite(equity)) {
            return null;
          }
          const parsed = new Date(point.timestamp);
          if (Number.isNaN(parsed.getTime())) {
            return null;
          }
          return {
            timestamp: point.timestamp,
            equity,
            date: parsed,
          };
        })
        .filter(
          (point): point is { timestamp: string; equity: number; date: Date } => point !== null,
        ),
    [data],
  );

  const spanMs = useMemo(() => {
    if (formatted.length < 2) {
      return 0;
    }
    return formatted[formatted.length - 1].date.getTime() - formatted[0].date.getTime();
  }, [formatted]);

  const baseline = formatted.length > 0 ? formatted[0].equity : null;
  const showBrush = formatted.length > 60;

  const tickFormatter = useCallback(
    (value: string) => {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return value;
      }
      const dayMs = 24 * 60 * 60 * 1000;
      return spanMs > 5 * dayMs ? axisDateFormatter.format(parsed) : axisDateTimeFormatter.format(parsed);
    },
    [axisDateFormatter, axisDateTimeFormatter, spanMs],
  );

  const tooltipLabelFormatter = useCallback(
    (value: string) => {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return value;
      }
      return `${tooltipDateTimeFormatter.format(parsed)} UTC`;
    },
    [tooltipDateTimeFormatter],
  );

  const tooltipValueFormatter = useCallback(
    (value: number) => {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return [String(value), "Equity"] as const;
      }
      const delta = baseline !== null ? value - baseline : null;
      const baseLabel = value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      if (delta === null) {
        return [baseLabel, "Equity"] as const;
      }
      const deltaLabel = `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
      return [`${baseLabel} (${deltaLabel})`, "Equity"] as const;
    },
    [baseline],
  );

  return (
    <div className="equity-chart">
      {formatted.length === 0 ? (
        <div className="equity-placeholder">No equity data yet</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%" minHeight={260}>
          <AreaChart data={formatted} margin={{ top: 10, right: 24, bottom: showBrush ? 40 : 10, left: 0 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#42a5f5" stopOpacity={0.32} />
                <stop offset="60%" stopColor="#1ee3ff" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#1ee3ff" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2e39" />
            <XAxis
              dataKey="timestamp"
              tick={{ fill: "#b0b4c4" }}
              minTickGap={40}
              tickFormatter={tickFormatter}
              height={36}
            />
            <YAxis
              tick={{ fill: "#b0b4c4" }}
              domain={["dataMin", "dataMax"]}
              width={70}
              tickFormatter={(value: number) =>
                value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
              }
            />
            <Tooltip
              contentStyle={{ background: "#12151c", border: "1px solid #2a2e39" }}
              labelStyle={{ color: "#fff" }}
              formatter={tooltipValueFormatter}
              labelFormatter={tooltipLabelFormatter}
            />
            {baseline !== null && (
              <ReferenceLine
                y={baseline}
                stroke="rgba(118, 107, 255, 0.45)"
                strokeDasharray="4 4"
                label={{ value: `Start ${baseline.toFixed(2)}`, position: "right", fill: "#9ca5c7", fontSize: 11 }}
              />
            )}
            <Area type="monotone" dataKey="equity" stroke="#42a5f5" strokeWidth={2} fill="url(#equityGradient)" />
            {showBrush && (
              <Brush
                dataKey="timestamp"
                height={26}
                stroke="rgba(30, 227, 255, 0.6)"
                travellerWidth={10}
                tickFormatter={tickFormatter}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};

export default EquityCurveChart;
