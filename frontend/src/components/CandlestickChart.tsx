import { useCallback, useEffect, useRef } from "react";
import {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  LineStyle,
  MouseEventHandler,
  SeriesMarker,
  Time,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";

import { IndicatorPoint, PriceCandle, TradeResult } from "../api/types";

type Props = {
  candles: PriceCandle[];
  trades?: TradeResult[];
  onHoverCandle?: (candle: PriceCandle | null) => void;
  onSelectCandle?: (candle: PriceCandle | null) => void;
  indicatorLines?: Record<string, IndicatorPoint[]>;
  focusRequest?: { time: string; requestId: number } | null;
  onFocusHandled?: () => void;
};

const indicatorPalette = ["#18c5ff", "#f48fb1", "#ffd54f", "#c5e1a5", "#b39ddb", "#80cbc4"];

const CandlestickChart = ({
  candles,
  trades = [],
  onHoverCandle,
  onSelectCandle,
  indicatorLines = {},
  focusRequest,
  onFocusHandled,
}: Props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candleMapRef = useRef<Map<number, PriceCandle>>(new Map());
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const timeIndexMapRef = useRef<Map<number, number>>(new Map());
  const orderedTimesRef = useRef<number[]>([]);
  const baseMarkersRef = useRef<SeriesMarker<"Candlestick">[]>([]);
  const focusMarkerRef = useRef<SeriesMarker<"Candlestick"> | null>(null);

  const toUnixTime = (value: string): UTCTimestamp | null => {
    const millis = new Date(value).getTime();
    if (!Number.isFinite(millis)) {
      return null;
    }
    const seconds = Math.floor(millis / 1000);
    return Number.isFinite(seconds) ? (seconds as UTCTimestamp) : null;
  };

  const resolveTimeKey = useCallback((time: Time): number | null => {
    if (typeof time === "number") {
      return time;
    }
    if (typeof time === "string") {
      const parsed = Number(time);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof time === "object" && "year" in time && "month" in time && "day" in time) {
      const unix = Date.UTC(time.year, time.month - 1, time.day) / 1000;
      return Number.isFinite(unix) ? (unix as number) : null;
    }
    return null;
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0e1016" }, textColor: "#d1d4dc" },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      grid: {
        vertLines: { color: "rgba(42,46,57,0.5)", style: LineStyle.Dotted },
        horzLines: { color: "rgba(42,46,57,0.5)", style: LineStyle.Dotted },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    chartRef.current = chart;
    seriesRef.current = series;
    indicatorSeriesRef.current = new Map();

    const containerElement = containerRef.current;

    const handleResize = () => {
      if (!containerElement) return;
      const { clientWidth, clientHeight } = containerElement;
      chart.resize(clientWidth, clientHeight);
    };

    handleResize();

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          chart.resize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height));
        })
      : null;

    if (resizeObserver && containerElement) {
      resizeObserver.observe(containerElement);
    } else {
      window.addEventListener("resize", handleResize);
    }

    return () => {
      if (resizeObserver && containerElement) {
        resizeObserver.unobserve(containerElement);
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", handleResize);
      }
      indicatorSeriesRef.current.forEach((indicatorSeries) => {
        try {
          chart.removeSeries(indicatorSeries);
        } catch (error) {
          // ignore cleanup errors
        }
      });
      indicatorSeriesRef.current.clear();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    const sanitized = candles
      .map((candle) => {
        const time = toUnixTime(candle.timestamp);
        if (time == null) {
          return null;
        }
        if (
          !Number.isFinite(candle.open) ||
          !Number.isFinite(candle.high) ||
          !Number.isFinite(candle.low) ||
          !Number.isFinite(candle.close)
        ) {
          return null;
        }
        return { time, candle };
      })
      .filter((entry): entry is { time: UTCTimestamp; candle: PriceCandle } => entry !== null);

    const data: CandlestickData[] = sanitized.map(({ time, candle }) => ({
      time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    seriesRef.current.setData(data);

    const map = new Map<number, PriceCandle>();
    const indexMap = new Map<number, number>();
    const orderedTimes: number[] = [];
    sanitized.forEach(({ time, candle }, index) => {
      const numericTime = time as number;
      map.set(numericTime, candle);
      indexMap.set(numericTime, index);
      orderedTimes.push(numericTime);
    });
    candleMapRef.current = map;
    timeIndexMapRef.current = indexMap;
    orderedTimesRef.current = orderedTimes;

    if (chartRef.current && data.length > 0) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles]);

  const applyMarkers = useCallback(() => {
    if (!seriesRef.current) {
      return;
    }
    const merged = [...baseMarkersRef.current];
    if (focusMarkerRef.current) {
      merged.push(focusMarkerRef.current);
    }
    merged.sort((left, right) => {
      const leftTime = resolveTimeKey(left.time);
      const rightTime = resolveTimeKey(right.time);
      return (leftTime ?? Number.NEGATIVE_INFINITY) - (rightTime ?? Number.NEGATIVE_INFINITY);
    });
    seriesRef.current.setMarkers(merged);
  }, [resolveTimeKey]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }
    const markers: SeriesMarker<"Candlestick">[] = [];

    trades.forEach((trade, index) => {
      const entryTime = toUnixTime(trade.entryTime);
      const exitTime = toUnixTime(trade.exitTime);
      const entryColor = trade.direction === "long" ? "#26a69a" : "#ef5350";
      const exitColor = trade.direction === "long" ? "#ffa726" : "#29b6f6";

      if (entryTime != null) {
        markers.push({
          time: entryTime as Time,
          position: trade.direction === "long" ? "belowBar" : "aboveBar",
          color: entryColor,
          shape: trade.direction === "long" ? "arrowUp" : "arrowDown",
          text: `Entry #${index + 1}`,
        } as SeriesMarker<"Candlestick">);
      }

      if (exitTime != null) {
        markers.push({
          time: exitTime as Time,
          position: trade.direction === "long" ? "aboveBar" : "belowBar",
          color: exitColor,
          shape: "circle",
          text: `Exit #${index + 1}`,
        } as SeriesMarker<"Candlestick">);
      }
    });

    markers.sort((left, right) => {
      const leftTime = resolveTimeKey(left.time);
      const rightTime = resolveTimeKey(right.time);
      return (leftTime ?? Number.NEGATIVE_INFINITY) - (rightTime ?? Number.NEGATIVE_INFINITY);
    });
    baseMarkersRef.current = markers;
    applyMarkers();
  }, [trades, applyMarkers, resolveTimeKey]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = chartRef.current;
    const seriesMap = indicatorSeriesRef.current;

    seriesMap.forEach((series, name) => {
      if (!indicatorLines[name]) {
        chart.removeSeries(series);
        seriesMap.delete(name);
      }
    });

    Object.entries(indicatorLines).forEach(([name, points], index) => {
      if (points.length === 0) {
        return;
      }
      let series = seriesMap.get(name);
      if (!series) {
        series = chart.addLineSeries({
          color: indicatorPalette[index % indicatorPalette.length],
          lineWidth: 2,
          title: name,
        });
        seriesMap.set(name, series);
      }

      const data = points
        .map((point) => {
          const time = toUnixTime(point.timestamp);
          if (time == null || !Number.isFinite(point.value)) {
            return null;
          }
          return {
            time,
            value: point.value,
          };
        })
        .filter((item): item is { time: UTCTimestamp; value: number } => item !== null);

      data.sort((a, b) => Number(a.time) - Number(b.time));

      series.setData(data);
    });
  }, [indicatorLines]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    const chart = chartRef.current;

    const handleCrosshairMove: MouseEventHandler<Time> = (param) => {
      if (!onHoverCandle) {
        return;
      }
      const timeValue = param.time;
      if (timeValue === undefined || timeValue === null) {
        onHoverCandle(null);
        return;
      }
      const resolved = resolveTimeKey(timeValue);
      if (resolved == null) {
        onHoverCandle(null);
        return;
      }
      const candle = candleMapRef.current.get(resolved) ?? null;
      onHoverCandle(candle ?? null);
    };

    const handleClick: MouseEventHandler<Time> = (param) => {
      if (!onSelectCandle) {
        return;
      }
      const timeValue = param.time;
      if (timeValue === undefined || timeValue === null) {
        onSelectCandle(null);
        return;
      }
      const resolved = resolveTimeKey(timeValue);
      if (resolved == null) {
        onSelectCandle(null);
        return;
      }
      const candle = candleMapRef.current.get(resolved) ?? null;
      onSelectCandle(candle ?? null);
    };

    if (onHoverCandle) {
      chart.subscribeCrosshairMove(handleCrosshairMove);
    }
    if (onSelectCandle) {
      chart.subscribeClick(handleClick);
    }

    return () => {
      if (onHoverCandle) {
        chart.unsubscribeCrosshairMove(handleCrosshairMove);
      }
      if (onSelectCandle) {
        chart.unsubscribeClick(handleClick);
      }
    };
  }, [onHoverCandle, onSelectCandle, resolveTimeKey]);

  useEffect(() => {
    if (!focusRequest || !chartRef.current) {
      focusMarkerRef.current = null;
      applyMarkers();
      return;
    }
    const { time } = focusRequest;
    const targetUnix = toUnixTime(time);
    if (targetUnix == null) {
      focusMarkerRef.current = null;
      applyMarkers();
      return;
    }
    const targetKey = Number(targetUnix);
    const index = timeIndexMapRef.current.get(targetKey);
    const times = orderedTimesRef.current;
    if (index == null || times.length === 0) {
      focusMarkerRef.current = null;
      applyMarkers();
      return;
    }

    const lastIndex = times.length - 1;
    const scale = chartRef.current.timeScale();
    const halfWindow = Math.max(20, Math.round(times.length * 0.05));
    const fromIndex = Math.max(0, index - halfWindow);
    const toIndex = Math.min(lastIndex, index + halfWindow);
    const fromTime = times[fromIndex];
    const toTime = times[toIndex];

    if (fromTime !== undefined && toTime !== undefined) {
      scale.setVisibleRange({ from: fromTime as Time, to: toTime as Time });
    }

    const logicalFromEnd = index - lastIndex;
    scale.scrollToPosition(logicalFromEnd, true);

    focusMarkerRef.current = {
      time: targetUnix as Time,
      position: "inBar",
      color: "#1ee3ff",
      shape: "square",
      text: "Focused",
    } as SeriesMarker<"Candlestick">;
    applyMarkers();
    onFocusHandled?.();
  }, [focusRequest, applyMarkers, onFocusHandled]);

  return <div className="chart-container" ref={containerRef} />;
};

export default CandlestickChart;
