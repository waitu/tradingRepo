import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import toast, { Toaster } from "react-hot-toast";

import api from "../api/client";
import CandlestickChart, { indicatorPalette } from "../components/CandlestickChart";
import EquityCurveChart from "../components/EquityCurveChart";
import MetricsPanel from "../components/MetricsPanel";
import TradeHistoryTable from "../components/TradeHistoryTable";
import TradesAnalysisPanel from "../components/TradesAnalysisPanel";
import {
  BacktestRequestPayload,
  BacktestResponse,
  DatasetListItem,
  PriceCandle,
  StrategyRules,
  StrategyType,
  TradeResult,
} from "../api/types";

const timeframeOptions = ["1h", "4h", "1d"];

const indicatorTogglePriority = ["EMA", "KEMA Adaptive", "Upper Band", "Lower Band"];

const indicatorDisplayLabels: Record<string, string> = {
  "KEMA Adaptive": "KEMA (Adaptive)",
  "Upper Band": "Upper Band",
  "Lower Band": "Lower Band",
};

const kemaOptionTemplate = `//@version=5
strategy("KEMA True Adaptive Strategy", overlay=true, margin_long=100, margin_short=100)

// === Inputs ===
length = input.int(20, "Base Length", minval=1)
process_noise = input.float(0.01, "Process Noise (Q)", step=0.001)
measurement_noise = input.float(0.1, "Measurement Noise (R)", step=0.001)
volatility_factor = input.float(1.5, "Volatility Factor", step=0.1)
atr_len = input.int(14, "ATR Length", minval=1)
trade_option = input.string("Both", "Trade Option", options=["Long Only", "Short Only", "Both"])

// === Kalman Filter EMA ===
var float estimate = na
var float error_cov = 1.0

src = close
Q = process_noise
R = measurement_noise

if na(estimate)
    estimate := src
else
    // Prediction
    estimate := estimate
    error_cov := error_cov + Q

    // Update
    K = error_cov / (error_cov + R)
    estimate := estimate + K * (src - estimate)
    error_cov := (1 - K) * error_cov

kema = estimate

// === Volatility Band ===
atr = ta.atr(atr_len)
upper_band = kema + volatility_factor * atr
lower_band = kema - volatility_factor * atr

// === Entry/Exit Conditions ===
longEntry  = ta.crossover(close, upper_band)
shortEntry = ta.crossunder(close, lower_band)
longExit   = ta.crossunder(close, lower_band)
shortExit  = ta.crossover(close, upper_band)

if trade_option == "Long Only" or trade_option == "Both"
    if longEntry
        strategy.entry("Long", strategy.long)
    if longExit
        strategy.close("Long")

if trade_option == "Short Only" or trade_option == "Both"
    if shortEntry
        strategy.entry("Short", strategy.short)
    if shortExit
        strategy.close("Short")

// === Plots ===
plot(kema, color=color.new(color.blue, 0), title="KEMA", linewidth=2)
plot(upper_band, color=color.new(color.red, 0), title="Upper Band", linewidth=1)
plot(lower_band, color=color.new(color.green, 0), title="Lower Band", linewidth=1)`;

const emaAtrBreakoutTemplate = `//@version=4
strategy("KEMA-Option", overlay=true)
length_ema = input(15, minval=1, title="Length EMA")
length_atr = input(14, minval=1, title="Length ATR")
volatility_factor = input(1, title="Volatility Factor", type=input.float)
initial_risk = input(2, title="% Initial Risk", type=input.float) / 100
risk_equity = input(50, title="% Risk Equity", type=input.float) / 100
trade_option = input("Both", title="Trade Option", options=["Long Only", "Short Only", "Both"])
use_kema = input.bool(false, "Use KEMA (Adaptive EMA)")
equity = strategy.equity
startYear = input(1900, title="Start Year", minval=1900)
startMonth = input(1, title="Start Month", minval=1, maxval=12)
startDay = input(1, title="Start Day", minval=1, maxval=31)
endYear = input(2024, title="End Year", minval=1900)
endMonth = input(12, title="End Month", minval=1, maxval=12)
endDay = input(31, title="End Day", minval=1, maxval=31)
startDate = timestamp(startYear, startMonth, startDay, 00, 00)
endDate = timestamp(endYear, endMonth, endDay, 23, 59)
src = close
ema_val = ema(src, length_ema)
atr_val = ema(tr, length_atr)
f_atr = 1 + (atr_val / ema_val)
kema_val = ema(src, length_ema * f_atr)
mid_val = use_kema ? kema_val : ema_val
upper_band = mid_val + volatility_factor * atr_val
lower_band = mid_val - volatility_factor * atr_val
ready = not na(ema_val) and not na(atr_val) and (not use_kema or not na(kema_val))
// Entry conditions
longEntry = crossover(close, upper_band)
shortEntry = crossunder(close, lower_band)
// Exit conditions
longExit = crossunder(close, lower_band)
shortExit = crossover(close, upper_band)
delta = upper_band - lower_band
contractsDelta = max(floor((initial_risk * equity) / (delta) * 10000) / 10000, 0.0001)
contractsATR = max(floor((initial_risk * equity) / (atr_val) * 10000) / 10000, 0.0001)
contractsEquityRisk = max(floor((risk_equity * equity) / (close) * 10000) / 10000, 0.0001)
contracts = min(contractsDelta, contractsATR, contractsEquityRisk)
if (time >= startDate and time <= endDate) and ready
  if (trade_option == "Long Only" or trade_option == "Both")
    if (longEntry)
      strategy.entry("Long", strategy.long, contracts)
    if (longExit)
      strategy.close("Long")
  if (trade_option == "Short Only" or trade_option == "Both")
    if (shortEntry)
      strategy.entry("Short", strategy.short, contracts)
    if (shortExit)
      strategy.close("Short")
else if (time[1] <= endDate)
  strategy.close_all()
plot(ema_val, color=color.blue, linewidth=1, title="EMA")
plot(kema_val, color=color.orange, linewidth=1, title="KEMA Adaptive")
plot(upper_band, color=color.red, linewidth=1, title="Upper")
plot(lower_band, color=color.green, linewidth=1, title="Lower")`;

const defaultPineScript = emaAtrBreakoutTemplate;

const PINE_STORAGE_KEY = "backtest:pineScript";
const STRATEGY_STORAGE_KEY = "backtest:strategyType";

type PineInputType = "int" | "float" | "bool" | "string";

type PineInputValue = number | string | boolean;

type PineInputField = {
  name: string;
  label: string;
  kind: PineInputType;
  value: PineInputValue;
  rest: string;
  suffix: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
};

const createPineInputRegex = () =>
  /([A-Za-z_]\w*)\s*=\s*input(?:\.(int|float|bool|string))?\(\s*([^,)]*)([^)]*)\)([^\n]*)/gi;

type RangePreset = "all" | "ytd" | "1y" | "6m" | "3m" | "1m" | "custom";

type AnalyticsViewMode = "all" | "equity" | "history" | "analysis";

const analyticsViewOptions: { key: AnalyticsViewMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "equity", label: "Equity Curve" },
  { key: "history", label: "Trade History" },
  { key: "analysis", label: "Trades Analysis" },
];

const parsePineInputs = (code: string): PineInputField[] => {
  const inputs: PineInputField[] = [];
  const regex = createPineInputRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    const [, name, explicitKind, defaultRaw, rest = "", suffix = ""] = match;
    const cleanRest = rest ?? "";
    const suffixText = suffix ?? "";

    const defvalMatch = cleanRest.match(/defval\s*=\s*([^,)+]+)/i);
    const trimmedDefault = (defaultRaw ?? "").trim() || defvalMatch?.[1]?.trim() || "";

    const detectedKind = (explicitKind as PineInputType | undefined) ?? "float";

    const getNumber = (key: string): number | undefined => {
      const found = cleanRest.match(new RegExp(`${key}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
      return found ? Number(found[1]) : undefined;
    };

    const optionsMatch = cleanRest.match(/options\s*=\s*\[([^\]]+)\]/i);
    const parsedOptions = optionsMatch
      ? optionsMatch[1]
          .split(",")
          .map((option) => option.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      : undefined;

    const titleMatch = cleanRest.match(/title\s*=\s*"([^"]+)"/i);
    let value: PineInputValue;
    if (detectedKind === "int" || detectedKind === "float") {
      const numeric = Number(trimmedDefault || (detectedKind === "int" ? "0" : "0"));
      value = Number.isNaN(numeric) ? 0 : numeric;
    } else if (detectedKind === "bool") {
      value = trimmedDefault.toLowerCase() === "true";
    } else {
      value = trimmedDefault.replace(/^['"]|['"]$/g, "");
      if (parsedOptions && parsedOptions.length > 0 && !parsedOptions.includes(String(value))) {
        value = parsedOptions[0];
      }
    }

    inputs.push({
      name,
      label: titleMatch?.[1] ?? name,
      kind: detectedKind,
      value,
      rest: cleanRest,
      suffix: suffixText,
      options: parsedOptions,
      min: getNumber("minval"),
      max: getNumber("maxval"),
      step: getNumber("step"),
    });
  }
  return inputs;
};

const formatPineValue = (kind: PineInputType, value: PineInputValue): string => {
  switch (kind) {
    case "int": {
      const numeric = Number(value);
      return String(Number.isFinite(numeric) ? Math.round(numeric) : 0);
    }
    case "float": {
      const numeric = Number(value);
      return String(Number.isFinite(numeric) ? numeric : 0);
    }
    case "bool":
      return value ? "true" : "false";
    case "string":
    default: {
      const stringValue = String(value);
      return `"${stringValue.replace(/"/g, '\\"')}"`;
    }
  }
};

const updatePineInputValue = (
  code: string,
  targetName: string,
  kind: PineInputType,
  newValue: PineInputValue,
): string =>
  code.replace(createPineInputRegex(), (full, name, explicitKind, _defaultRaw, rest, suffix = "") => {
    if (name !== targetName) {
      return full;
    }
    const formatted = formatPineValue(kind, newValue);
    const remainder = rest ?? "";
    const prefix = explicitKind ? `input.${explicitKind}` : "input";
    return `${name} = ${prefix}(${formatted}${remainder})${suffix ?? ""}`;
  });

const BacktestTradingPage = () => {
  const [datasets, setDatasets] = useState<DatasetListItem[]>([]);
  const [candles, setCandles] = useState<PriceCandle[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("");
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>(timeframeOptions[0]);
  const [initialCapital, setInitialCapital] = useState<number>(10000);
  const [tradingFee, setTradingFee] = useState<number>(0.1);
  const [lotSize, setLotSize] = useState<number>(0.0001);
  const [roundQuantity, setRoundQuantity] = useState<boolean>(true);
  const [executionModel, setExecutionModel] = useState<"close_signal_bar" | "open_next_bar">(
    "close_signal_bar",
  );
  const [startTime, setStartTime] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [strategyType, setStrategyType] = useState<StrategyType>(() => {
    if (typeof window === "undefined") return "pine_script";
    const stored = window.localStorage.getItem(STRATEGY_STORAGE_KEY) as StrategyType | null;
    return stored === "pine_script" || stored === "moving_average_cross" ? stored : "pine_script";
  });
  const [fastWindow, setFastWindow] = useState<number>(10);
  const [slowWindow, setSlowWindow] = useState<number>(25);
  const [allowShort, setAllowShort] = useState<boolean>(false);
  const [priceSource, setPriceSource] = useState<"close" | "open">("close");
  const [pineScript, setPineScript] = useState<string>(() => {
    if (typeof window === "undefined") return defaultPineScript;
    return window.localStorage.getItem(PINE_STORAGE_KEY) ?? defaultPineScript;
  });
  const [jsonEditorValue, setJsonEditorValue] = useState<string>("");

  const pineInputs = useMemo(() => parsePineInputs(pineScript), [pineScript]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PINE_STORAGE_KEY, pineScript);
    }
  }, [pineScript]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STRATEGY_STORAGE_KEY, strategyType);
    }
  }, [strategyType]);

  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState<boolean>(false);
  const [isCodePanelOpen, setIsCodePanelOpen] = useState<boolean>(false);
  const [activeCodeTab, setActiveCodeTab] = useState<"json" | "pine">("json");
  const [backtestResult, setBacktestResult] = useState<BacktestResponse>();
  const [executedTrades, setExecutedTrades] = useState<TradeResult[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadSymbol, setUploadSymbol] = useState<string>("");
  const [uploadTimeframe, setUploadTimeframe] = useState<string>(timeframeOptions[0]);
  const [showAnalytics, setShowAnalytics] = useState<boolean>(true);
  const [analyticsView, setAnalyticsView] = useState<AnalyticsViewMode>("all");
  const [isStrategyModalOpen, setIsStrategyModalOpen] = useState<boolean>(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [hoverCandle, setHoverCandle] = useState<PriceCandle | null>(null);
  const [selectedCandle, setSelectedCandle] = useState<PriceCandle | null>(null);
  const [chartFocusRequest, setChartFocusRequest] = useState<{ time: string; requestId: number } | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>("all");
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [indicatorVisibility, setIndicatorVisibility] = useState<Record<string, boolean>>({});

  const selectedDataset = useMemo(
    () =>
      datasets.find(
        (dataset) => dataset.symbol === selectedSymbol && dataset.timeframe === selectedTimeframe,
      ) ?? null,
    [datasets, selectedSymbol, selectedTimeframe],
  );

  const strategyRules: StrategyRules = useMemo(() => {
    if (strategyType === "moving_average_cross") {
      return {
        type: "moving_average_cross",
        fastWindow,
        slowWindow,
        source: priceSource,
        allowShort,
      };
    }
    return { type: "pine_script", code: pineScript };
  }, [strategyType, fastWindow, slowWindow, allowShort, pineScript, priceSource]);

  const strategySummary = useMemo(() => {
    if (strategyType === "moving_average_cross") {
      const sourceLabel = priceSource === "close" ? "close" : "open";
      return `Moving average crossover · fast ${fastWindow} / slow ${slowWindow} · ${sourceLabel} price`;
    }
    const adjustableCount = pineInputs.length;
    return adjustableCount > 0
      ? `Pine script · ${adjustableCount} adjustable ${adjustableCount === 1 ? "input" : "inputs"}`
      : "Pine script · No adjustable inputs detected";
  }, [strategyType, fastWindow, slowWindow, priceSource, pineInputs]);

  const toUnixSeconds = useCallback((value: string) => Math.floor(new Date(value).getTime() / 1000), []);

  const utcDateTimeFormatter = useMemo(
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

  const formatDateTime = useCallback(
    (value: string) => {
      try {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }
        return utcDateTimeFormatter.format(date) + " UTC";
      } catch (error) {
        return value;
      }
    },
    [utcDateTimeFormatter],
  );

  const datasetSpanLabel = useMemo(() => {
    if (!selectedDataset) {
      return null;
    }
    const startLabel = selectedDataset.earliest
      ? formatDateTime(selectedDataset.earliest)
      : "Unknown start";
    const endLabel = selectedDataset.latest
      ? formatDateTime(selectedDataset.latest)
      : "Latest candle";
    return `${startLabel} – ${endLabel}`;
  }, [formatDateTime, selectedDataset]);

  useEffect(() => {
    const lines = backtestResult?.indicatorLines;
    if (!lines || Object.keys(lines).length === 0) {
      setIndicatorVisibility((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    setIndicatorVisibility((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;

      Object.keys(lines).forEach((name) => {
        if (Object.prototype.hasOwnProperty.call(prev, name)) {
          next[name] = prev[name];
        } else {
          next[name] = true;
          changed = true;
        }
      });

      if (Object.keys(prev).some((name) => !Object.prototype.hasOwnProperty.call(lines, name))) {
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [backtestResult?.indicatorLines]);

  const filteredIndicatorLines = useMemo(() => {
    const lines = backtestResult?.indicatorLines ?? {};
    return Object.fromEntries(
      Object.entries(lines).filter(([name]) => indicatorVisibility[name] !== false),
    ) as BacktestResponse["indicatorLines"];
  }, [backtestResult?.indicatorLines, indicatorVisibility]);
  const availableIndicatorNames = useMemo(() => {
    const lines = backtestResult?.indicatorLines;
    if (!lines) {
      return [] as string[];
    }
    return Object.keys(lines).filter((name) => (lines[name]?.length ?? 0) > 0);
  }, [backtestResult?.indicatorLines]);

  const orderedIndicatorNames = useMemo(() => {
    if (availableIndicatorNames.length === 0) {
      return [] as string[];
    }
    const prioritized = indicatorTogglePriority.filter((name) => availableIndicatorNames.includes(name));
    const extras = availableIndicatorNames.filter((name) => !indicatorTogglePriority.includes(name));
    return [...prioritized, ...extras];
  }, [availableIndicatorNames]);

  const indicatorColorMap = useMemo(() => {
    const lines = backtestResult?.indicatorLines ?? {};
    const map: Record<string, string> = {};
    Object.keys(lines).forEach((name, index) => {
      map[name] = indicatorPalette[index % indicatorPalette.length];
    });
    return map;
  }, [backtestResult?.indicatorLines]);

  const indicatorControlsVisible = orderedIndicatorNames.length > 0;

  const formatPrice = useCallback((value: number) => {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, []);

  const formatPositionSize = useCallback((value: number) => {
    return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }, []);

  const formatPercent = useCallback((value: number) => {
    const sign = value > 0 ? "+" : value < 0 ? "" : "";
    return `${sign}${value.toFixed(2)}%`;
  }, []);

  const formatVolume = useCallback((value: number) => {
    if (Math.abs(value) >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (Math.abs(value) >= 1_000) {
      return `${(value / 1_000).toFixed(2)}K`;
    }
    return value.toLocaleString();
  }, []);

  const runConfigDetails = useMemo(
    () =>
      !backtestResult
        ? []
        : [
            {
              key: "initial-capital",
              label: "Initial Capital",
              value: formatPrice(initialCapital),
            },
            {
              key: "trading-fee",
              label: "Trading Fee",
              value: `${Number.isFinite(tradingFee) ? tradingFee.toFixed(2) : "0.00"}%`,
            },
            {
              key: "lot-size",
              label: "Lot Size",
              value: formatPositionSize(lotSize),
            },
            {
              key: "round-quantity",
              label: "Round Quantity",
              value: roundQuantity ? "Enabled" : "Disabled",
            },
            {
              key: "execution-model",
              label: "Execution Model",
              value:
                (backtestResult.execution_model ?? executionModel) === "close_signal_bar"
                  ? "Close of signal bar"
                  : "Open of next bar",
            },
          ],
    [
      backtestResult,
      executionModel,
      formatPositionSize,
      formatPrice,
      initialCapital,
      lotSize,
      roundQuantity,
      tradingFee,
    ],
  );

  const findCandleByTime = useCallback(
    (time: string): PriceCandle | null => {
      const unix = toUnixSeconds(time);
      if (!Number.isFinite(unix)) {
        return null;
      }
      return candles.find((candle) => toUnixSeconds(candle.timestamp) === unix) ?? null;
    },
    [candles, toUnixSeconds],
  );

  const handleJumpToTrade = useCallback(
    (trade: TradeResult) => {
      const entryCandle = findCandleByTime(trade.entryTime);
      const exitCandle = findCandleByTime(trade.exitTime);
      const target = entryCandle ?? exitCandle ?? null;

      if (target) {
        setSelectedCandle(target);
        setHoverCandle(target);
        setChartFocusRequest({ time: target.timestamp, requestId: Date.now() });
      } else {
        setChartFocusRequest({ time: trade.entryTime, requestId: Date.now() });
      }
    },
    [findCandleByTime],
  );

  const clearChartFocusRequest = useCallback(() => {
    setChartFocusRequest(null);
  }, []);

  useEffect(() => {
    setJsonEditorValue(JSON.stringify(strategyRules, null, 2));
  }, [strategyRules]);

  const layoutColumns = useMemo(() => {
    const leftWidth = isLeftPanelOpen ? "minmax(280px, 24vw)" : "0px";
    const rightWidth = isCodePanelOpen ? "minmax(320px, 28vw)" : "0px";
    return `${leftWidth} minmax(0, 1fr) ${rightWidth}`;
  }, [isLeftPanelOpen, isCodePanelOpen]);

  useEffect(() => {
    if (!showAnalytics && analyticsView !== "all") {
      setAnalyticsView("all");
    }
  }, [showAnalytics, analyticsView]);

  const showAllPanels = analyticsView === "all";
  const equityPanelVisible = analyticsView === "all" || analyticsView === "equity";
  const historyPanelVisible = analyticsView === "all" || analyticsView === "history";
  const analysisPanelVisible = analyticsView === "all" || analyticsView === "analysis";

  const handlePineInputChange = useCallback(
    (name: string, kind: PineInputType, value: PineInputValue) => {
      setPineScript((prev) => updatePineInputValue(prev, name, kind, value));
    },
    [],
  );

  const layoutStyle = useMemo(() => ({ "--layout-columns": layoutColumns } as CSSProperties), [layoutColumns]);

  useEffect(() => {
    if ((!isStrategyModalOpen && !isImportModalOpen) || typeof document === "undefined") {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isStrategyModalOpen, isImportModalOpen]);

  useEffect(() => {
    if ((!isStrategyModalOpen && !isImportModalOpen) || typeof window === "undefined") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isImportModalOpen) {
          setIsImportModalOpen(false);
        } else if (isStrategyModalOpen) {
          setIsStrategyModalOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isStrategyModalOpen, isImportModalOpen]);

  const formatDateForInput = useCallback((date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }, []);

  const datasetBounds = useMemo(() => {
    const parseBoundary = (value: string | null | undefined): Date | null => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    return {
      earliest: parseBoundary(selectedDataset?.earliest),
      latest: parseBoundary(selectedDataset?.latest),
    };
  }, [selectedDataset]);

  const applyRangePreset = useCallback(
    (preset: RangePreset) => {
      if (!selectedDataset) {
        if (preset === "custom") {
          setStartTime(customRange.start);
          setEndTime(customRange.end);
        } else {
          setStartTime("");
          setEndTime("");
        }
        return;
      }

      const fallbackStart = new Date(Date.UTC(1900, 0, 1, 0, 0, 0));
      const fallbackEnd = new Date();
      const datasetStart = datasetBounds.earliest ?? fallbackStart;
      const datasetEnd = datasetBounds.latest ?? fallbackEnd;

      const clampToDataset = (candidate: Date) => {
        if (datasetBounds.earliest && candidate < datasetBounds.earliest) {
          return new Date(datasetBounds.earliest.getTime());
        }
        if (candidate > datasetEnd) {
          return new Date(datasetEnd.getTime());
        }
        return candidate;
      };

      const ensureOrder = (start: Date, end: Date) => {
        if (start.getTime() > end.getTime()) {
          return new Date(end.getTime());
        }
        return start;
      };

      const setRangeFromDates = (start: Date | null, end: Date | null) => {
        setStartTime(start ? formatDateForInput(start) : "");
        setEndTime(end ? formatDateForInput(end) : "");
      };

      switch (preset) {
        case "all": {
          setRangeFromDates(new Date(datasetStart.getTime()), new Date(datasetEnd.getTime()));
          break;
        }
        case "ytd": {
          const end = new Date(datasetEnd.getTime());
          const yearStart = new Date(end.getFullYear(), 0, 1, 0, 0, 0, 0);
          const start = ensureOrder(clampToDataset(yearStart), end);
          setRangeFromDates(start, end);
          break;
        }
        case "1y": {
          const end = new Date(datasetEnd.getTime());
          const startCandidate = new Date(end.getTime());
          startCandidate.setFullYear(startCandidate.getFullYear() - 1);
          const start = ensureOrder(clampToDataset(startCandidate), end);
          setRangeFromDates(start, end);
          break;
        }
        case "6m":
        case "3m":
        case "1m": {
          const end = new Date(datasetEnd.getTime());
          const startCandidate = new Date(end.getTime());
          const monthsBack = preset === "6m" ? 6 : preset === "3m" ? 3 : 1;
          startCandidate.setMonth(startCandidate.getMonth() - monthsBack);
          const start = ensureOrder(clampToDataset(startCandidate), end);
          setRangeFromDates(start, end);
          break;
        }
        case "custom": {
          setStartTime(customRange.start);
          setEndTime(customRange.end);
          break;
        }
        default: {
          setRangeFromDates(new Date(datasetStart.getTime()), new Date(datasetEnd.getTime()));
        }
      }
    },
    [customRange, datasetBounds, formatDateForInput, selectedDataset],
  );

  useEffect(() => {
    applyRangePreset(rangePreset);
  }, [applyRangePreset, rangePreset]);

  const resetRangePreset = useCallback(() => {
    setCustomRange({ start: "", end: "" });
    setRangePreset("all");
  }, []);

  const handleSelectPreset = useCallback(
    (preset: RangePreset) => {
      if (preset === "custom") {
        setCustomRange((prev) => ({
          start: prev.start || startTime,
          end: prev.end || endTime,
        }));
      }
      setRangePreset(preset);
    },
    [endTime, startTime],
  );

  const handleCustomStartChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setCustomRange((prev) => ({ ...prev, start: value }));
      setStartTime(value);
      if (rangePreset !== "custom") {
        setRangePreset("custom");
      }
    },
    [rangePreset],
  );

  const handleCustomEndChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setCustomRange((prev) => ({ ...prev, end: value }));
      setEndTime(value);
      if (rangePreset !== "custom") {
        setRangePreset("custom");
      }
    },
    [rangePreset],
  );

  const loadDatasets = async () => {
    try {
      const { data } = await api.get<DatasetListItem[]>("/price-data/datasets");
      setDatasets(data);
      const exists = data.some(
        (item: DatasetListItem) => item.symbol === selectedSymbol && item.timeframe === selectedTimeframe,
      );
      if (data.length > 0 && (!selectedSymbol || !exists)) {
        setSelectedSymbol(data[0].symbol);
        setSelectedTimeframe(data[0].timeframe);
      }
    } catch (error) {
      toast.error("Failed to load datasets");
    }
  };

  useEffect(() => {
    loadDatasets();
  }, []);

  useEffect(() => {
    if (!selectedSymbol || !selectedTimeframe) {
      return;
    }
    const fetchCandles = async () => {
      try {
        const { data } = await api.get<PriceCandle[]>("/price-data/candles", {
          params: { symbol: selectedSymbol, timeframe: selectedTimeframe },
        });
        setCandles(data);
        setHoverCandle(null);
        setSelectedCandle(null);
      } catch (error) {
        toast.error("Unable to fetch candles for chart");
      }
    };
    fetchCandles();
  }, [selectedSymbol, selectedTimeframe]);

  const handleDatasetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value) {
      setSelectedSymbol("");
      return;
    }
    const [symbol, timeframe] = value.split("__");
    setSelectedSymbol(symbol);
    setSelectedTimeframe(timeframe);
    resetRangePreset();
  };

  const handleTimeframeSelect = useCallback(
    (timeframe: string) => {
      setSelectedTimeframe(timeframe);
      resetRangePreset();
    },
    [resetRangePreset],
  );

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (!(file instanceof File)) {
      toast.error("Please select a CSV file to upload");
      return;
    }
    if (!uploadSymbol) {
      toast.error("Symbol is required");
      return;
    }
    setIsUploading(true);
    try {
      const payload = new FormData();
      payload.append("symbol", uploadSymbol);
      payload.append("timeframe", uploadTimeframe);
      payload.append("file", file);
      payload.append("replaceExisting", "true");

      await api.post("/price-data/import", payload, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      toast.success("Dataset imported successfully");
      setUploadSymbol("");
      (event.currentTarget.elements.namedItem("file") as HTMLInputElement).value = "";
      await loadDatasets();
      setSelectedSymbol(uploadSymbol);
      setSelectedTimeframe(uploadTimeframe);
  resetRangePreset();
      setIsImportModalOpen(false);
    } catch (error) {
      toast.error("Failed to import dataset");
    } finally {
      setIsUploading(false);
    }
  };

  const buildPayload = (): BacktestRequestPayload | undefined => {
    if (!selectedSymbol) {
      toast.error("Select a dataset before running backtest");
      return undefined;
    }
    const normalizedLotSize = Number.isFinite(lotSize) && lotSize >= 0 ? lotSize : 0.0001;
    const normalizedRoundQuantity = Boolean(roundQuantity);
    const payload: BacktestRequestPayload = {
      initialCapital,
      tradingFee,
      symbol: selectedSymbol,
      timeframe: selectedTimeframe,
      strategyRules,
      lot_size: normalizedLotSize,
      round_quantity: normalizedRoundQuantity,
      execution_model: executionModel,
    };
    if (startTime) {
      payload.startTime = new Date(startTime).toISOString();
    }
    if (endTime) {
      payload.endTime = new Date(endTime).toISOString();
    }
    return payload;
  };

  const handleRunBacktest = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setIsRunning(true);
    try {
      const { data } = await api.post<BacktestResponse>("/backtest/run", payload);
      setBacktestResult(data);
      setExecutedTrades(data.executedTrades);
      if (typeof data.lot_size === "number" && Number.isFinite(data.lot_size)) {
        setLotSize(data.lot_size);
      }
      if (typeof data.round_quantity === "boolean") {
        setRoundQuantity(data.round_quantity);
      }
      if (data.execution_model === "close_signal_bar" || data.execution_model === "open_next_bar") {
        setExecutionModel(data.execution_model);
      }
      toast.success("Backtest completed");
    } catch (error: unknown) {
      const message =
        isAxiosError(error) && error.response?.data?.detail
          ? String(error.response.data.detail)
          : "Backtest failed";
      toast.error(message);
    } finally {
      setIsRunning(false);
    }
  };

  const handleIndicatorToggle = useCallback(
    (name: string, checked: boolean) => {
      setIndicatorVisibility((prev) => ({ ...prev, [name]: checked }));
    },
    [setIndicatorVisibility],
  );

  const applyJsonEditor = () => {
    try {
      const parsed = JSON.parse(jsonEditorValue);
      if (!parsed.type) {
        throw new Error("Strategy type missing");
      }
      if (parsed.type === "moving_average_cross") {
        setStrategyType("moving_average_cross");
        if (typeof parsed.fastWindow === "number") {
          setFastWindow(parsed.fastWindow);
        }
        if (typeof parsed.slowWindow === "number") {
          setSlowWindow(parsed.slowWindow);
        }
        if (typeof parsed.allowShort === "boolean") {
          setAllowShort(parsed.allowShort);
        }
        if (parsed.source === "open" || parsed.source === "close") {
          setPriceSource(parsed.source);
        }
      } else if (parsed.type === "pine_script") {
        setStrategyType("pine_script");
        if (parsed.code) {
          setPineScript(parsed.code);
        }
      } else {
        throw new Error(`Unsupported strategy type: ${parsed.type}`);
      }
      toast.success("Strategy JSON applied");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      toast.error(`Invalid JSON: ${message}`);
    }
  };

  const strategyConfigContent = (
    <>
      <div className="strategy-tabs strategy-modal-tabs">
        <button
          className={strategyType === "moving_average_cross" ? "active" : ""}
          onClick={() => setStrategyType("moving_average_cross")}
        >
          Moving Average
        </button>
        <button
          className={strategyType === "pine_script" ? "active" : ""}
          onClick={() => setStrategyType("pine_script")}
        >
          Pine Script
        </button>
      </div>
      <div className="strategy-modal-grid">
        <div className="strategy-modal-section">
          {strategyType === "moving_average_cross" ? (
            <div className="strategy-form">
              <label htmlFor="fast-window">Fast MA</label>
              <input
                id="fast-window"
                type="number"
                min="1"
                value={fastWindow}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setFastWindow(Number(event.target.value))
                }
              />
              <label htmlFor="slow-window">Slow MA</label>
              <input
                id="slow-window"
                type="number"
                min="2"
                value={slowWindow}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setSlowWindow(Number(event.target.value))
                }
              />
              <label htmlFor="price-source">Price Source</label>
              <select
                id="price-source"
                value={priceSource}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setPriceSource(event.target.value as "close" | "open")
                }
              >
                <option value="close">Close</option>
                <option value="open">Open</option>
              </select>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allowShort}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setAllowShort(event.target.checked)
                  }
                />
                Allow short entries (experimental)
              </label>
            </div>
          ) : (
            <div className="strategy-form">
              <label htmlFor="pine-script">Pine Script (beta)</label>
              <textarea
                id="pine-script"
                value={pineScript}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  setPineScript(event.target.value)
                }
                rows={12}
              />
              <div className="pine-template-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPineScript(kemaOptionTemplate)}
                >
                  Load KEMA adaptive template
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPineScript(emaAtrBreakoutTemplate)}
                >
                  Load EMA breakout template (KEMA toggle)
                </button>
              </div>
              <p className="hint">
                Define inputs with <code>input.*</code> to surface adjustable parameters below without leaving the
                controls panel. Load the EMA breakout template to get a <strong>Use KEMA (Adaptive EMA)</strong> toggle in
                the Pine inputs list.
              </p>
            </div>
          )}
        </div>
        <div className="strategy-modal-section hint-section">
          <div className="indicator-hint">
            <h3>Pine Inputs</h3>
            {strategyType === "pine_script" ? (
              pineInputs.length > 0 ? (
                <div className="pine-params">
                  {pineInputs.map((input) => {
                    const inputId = `pine-input-${input.name}`;
                    if (input.kind === "bool") {
                      return (
                        <div className="pine-param-field boolean" key={input.name}>
                          <div className="field-header">
                            <label htmlFor={inputId}>{input.label}</label>
                            <span className="input-kind">bool</span>
                          </div>
                          <label className="pine-param-toggle" htmlFor={inputId}>
                            <input
                              id={inputId}
                              type="checkbox"
                              checked={Boolean(input.value)}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                handlePineInputChange(input.name, input.kind, event.target.checked)
                              }
                            />
                            <span>{Boolean(input.value) ? "Enabled" : "Disabled"}</span>
                          </label>
                        </div>
                      );
                    }

                    if (input.kind === "string") {
                      if (input.options && input.options.length > 0) {
                        return (
                          <div className="pine-param-field" key={input.name}>
                            <div className="field-header">
                              <label htmlFor={inputId}>{input.label}</label>
                              <span className="input-kind">select</span>
                            </div>
                            <select
                              id={inputId}
                              value={String(input.value)}
                              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                handlePineInputChange(input.name, input.kind, event.target.value)
                              }
                            >
                              {input.options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      }
                      return (
                        <div className="pine-param-field" key={input.name}>
                          <div className="field-header">
                            <label htmlFor={inputId}>{input.label}</label>
                            <span className="input-kind">text</span>
                          </div>
                          <input
                            id={inputId}
                            type="text"
                            value={String(input.value)}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                              handlePineInputChange(input.name, input.kind, event.target.value)
                            }
                          />
                        </div>
                      );
                    }

                    const numericValue = typeof input.value === "number" ? input.value : Number(input.value);
                    return (
                      <div className="pine-param-field" key={input.name}>
                        <div className="field-header">
                          <label htmlFor={inputId}>{input.label}</label>
                          <span className="input-kind">{input.kind === "int" ? "int" : "float"}</span>
                        </div>
                        <input
                          id={inputId}
                          type="number"
                          value={Number.isFinite(numericValue) ? numericValue : 0}
                          min={input.min}
                          max={input.max}
                          step={input.step ?? (input.kind === "float" ? "0.1" : "1")}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => {
                            const raw = event.target.value;
                            if (raw === "") return;
                            const parsed = Number(raw);
                            if (Number.isNaN(parsed)) return;
                            handlePineInputChange(
                              input.name,
                              input.kind,
                              input.kind === "int" ? Math.round(parsed) : parsed,
                            );
                          }}
                        />
                        {(input.min !== undefined || input.max !== undefined) && (
                          <div className="range-hint">
                            {input.min !== undefined && <span>min {input.min}</span>}
                            {input.max !== undefined && <span>max {input.max}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p>
                  Add <code>input.*</code> declarations to your script and they&apos;ll appear here instantly for quick
                  tweaking.
                </p>
              )
            ) : (
              <p>
                Switch to Pine Script mode or apply a Pine strategy to surface interactive indicator parameters.
              </p>
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setStrategyType("pine_script");
                setActiveCodeTab("pine");
                setIsCodePanelOpen(true);
                setIsStrategyModalOpen(false);
              }}
            >
              Jump to Pine editor
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const openStrategyModal = useCallback(() => setIsStrategyModalOpen(true), []);
  const closeStrategyModal = useCallback(() => setIsStrategyModalOpen(false), []);
  const openImportModal = useCallback(() => setIsImportModalOpen(true), []);
  const closeImportModal = useCallback(() => setIsImportModalOpen(false), []);

  return (
    <div className="page-shell">
      <Toaster position="top-right" />
      <header className="page-header">
        <div>
          <h1>Trading Backtest Lab</h1>
          <p>Test strategies with TradingView-style visuals and instant analytics.</p>
        </div>
        <div className="header-actions">
          <div className="header-toggle-group" role="group" aria-label="Workspace panels">
            <button
              type="button"
              className={`chip-toggle ${isLeftPanelOpen ? "active" : ""}`}
              aria-pressed={isLeftPanelOpen}
              onClick={() => setIsLeftPanelOpen((state) => !state)}
            >
              Controls
            </button>
            <button
              type="button"
              className={`chip-toggle ${showAnalytics ? "active" : ""}`}
              aria-pressed={showAnalytics}
              onClick={() => setShowAnalytics((state) => !state)}
            >
              Analytics
            </button>
            <button
              type="button"
              className={`chip-toggle ${isCodePanelOpen ? "active" : ""}`}
              aria-pressed={isCodePanelOpen}
              onClick={() => setIsCodePanelOpen((state) => !state)}
            >
              Code
            </button>
          </div>
          <button type="button" className="workspace-button" onClick={openStrategyModal}>
            Strategy Workspace
            <span className="workspace-hint">Popular</span>
          </button>
          <button type="button" className="secondary-button header-import-button" onClick={openImportModal}>
            Import CSV
          </button>
          <button onClick={() => handleRunBacktest()} className="primary-button" disabled={isRunning}>
            {isRunning ? "Running…" : "Run Backtest"}
          </button>
        </div>
      </header>

      <div className="page-layout" style={layoutStyle}>
        <aside className={`left-panel ${isLeftPanelOpen ? "" : "collapsed"}`} aria-hidden={!isLeftPanelOpen}>
          <div className="panel-toggle">
            <button type="button" onClick={() => setIsLeftPanelOpen((state) => !state)}>
              {isLeftPanelOpen ? "⟨" : "⟩"}
            </button>
            {isLeftPanelOpen && <span>Data Controls</span>}
          </div>
          {isLeftPanelOpen && (
            <div className="panel-stack">
              <section className="panel-block">
                <h2>Dataset</h2>
                <label htmlFor="dataset-select">Select Symbol & Timeframe</label>
                <select
                  id="dataset-select"
                  value={selectedSymbol ? `${selectedSymbol}__${selectedTimeframe}` : ""}
                  onChange={handleDatasetChange}
                >
                  <option value="" disabled>
                    {datasets.length === 0 ? "No datasets imported" : "Select dataset"}
                  </option>
                  {datasets.map((dataset) => (
                    <option key={`${dataset.symbol}-${dataset.timeframe}`} value={`${dataset.symbol}__${dataset.timeframe}`}>
                      {dataset.symbol} · {dataset.timeframe} ({dataset.candles} candles)
                    </option>
                  ))}
                </select>
                <div className="timeframe-picker">
                  <span>Quick timeframe</span>
                  <div className="timeframe-buttons">
                    {timeframeOptions.map((option) => (
                      <button
                        key={option}
                        className={option === selectedTimeframe ? "active" : ""}
                        onClick={() => handleTimeframeSelect(option)}
                        type="button"
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="panel-block">
                <h2>Capital & Fees</h2>
                <label htmlFor="initial-capital">Initial Capital</label>
                <input
                  id="initial-capital"
                  type="number"
                  min="100"
                  step="100"
                  value={initialCapital}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setInitialCapital(Number(event.target.value))
                  }
                />

                <label htmlFor="trading-fee">Trading Fee (%)</label>
                <input
                  id="trading-fee"
                  type="number"
                  min="0"
                  step="0.01"
                  value={tradingFee}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setTradingFee(Number(event.target.value))
                  }
                />

                <label htmlFor="lot-size">Lot Size</label>
                <input
                  id="lot-size"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={lotSize}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setLotSize(Number(event.target.value))
                  }
                />
                <p className="panel-hint">Set to 0 to disable lot rounding.</p>

                <label className="panel-checkbox">
                  <input
                    type="checkbox"
                    checked={roundQuantity}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setRoundQuantity(event.target.checked)
                    }
                  />
                  <span>Round quantity to lot size</span>
                </label>

                <label htmlFor="execution-model">Execution Model</label>
                <select
                  id="execution-model"
                  value={executionModel}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setExecutionModel(event.target.value as "close_signal_bar" | "open_next_bar")
                  }
                >
                  <option value="close_signal_bar">Close of signal bar (TradingView)</option>
                  <option value="open_next_bar">Open of next bar (realistic)</option>
                </select>

                <div className="date-range">
                  <div className="date-range-header">
                    <span>Date Range</span>
                    <div className="date-range-presets">
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "all" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("all")}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "ytd" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("ytd")}
                      >
                        YTD
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "1y" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("1y")}
                      >
                        1Y
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "6m" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("6m")}
                      >
                        6M
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "3m" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("3m")}
                      >
                        3M
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "1m" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("1m")}
                      >
                        1M
                      </button>
                      <button
                        type="button"
                        className={`chip-toggle ${rangePreset === "custom" ? "active" : ""}`}
                        onClick={() => handleSelectPreset("custom")}
                      >
                        Custom
                      </button>
                    </div>
                  </div>
                  {datasetSpanLabel && <p className="panel-hint dataset-span">Dataset span: {datasetSpanLabel}</p>}
                  <label>Start</label>
                  <input
                    type="datetime-local"
                    value={startTime}
                    onChange={handleCustomStartChange}
                    disabled={rangePreset !== "custom"}
                  />
                  <label>End</label>
                  <input
                    type="datetime-local"
                    value={endTime}
                    onChange={handleCustomEndChange}
                    disabled={rangePreset !== "custom"}
                  />
                  {rangePreset !== "custom" ? (
                    <p className="panel-hint">Select “Custom” to fine-tune the dates manually.</p>
                  ) : (
                    <p className="panel-hint">You&apos;re editing a custom window—switch presets for quick ranges.</p>
                  )}
                </div>
              </section>

              <section className="panel-block strategy-panel">
                <div className="strategy-panel-heading">
                  <h2>Strategy Tester</h2>
                  <span className="usage-badge">Most used</span>
                </div>
                <div className="strategy-summary">
                  <span>{strategySummary}</span>
                  {strategyType === "moving_average_cross" && allowShort && <span>· Shorts enabled</span>}
                </div>
                <div className="strategy-actions">
                  <button type="button" className="primary-button strategy-cta" onClick={openStrategyModal}>
                    Open Strategy Workspace
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setStrategyType("pine_script");
                      setActiveCodeTab("pine");
                      setIsCodePanelOpen(true);
                    }}
                  >
                    Jump to Pine editor
                  </button>
                </div>
                <p className="panel-hint">Pick your preset mode, then launch the workspace for full-screen controls.</p>
                <div className="strategy-tabs">
                  <button
                    className={strategyType === "moving_average_cross" ? "active" : ""}
                    onClick={() => setStrategyType("moving_average_cross")}
                  >
                    Moving Average
                  </button>
                  <button
                    className={strategyType === "pine_script" ? "active" : ""}
                    onClick={() => setStrategyType("pine_script")}
                  >
                    Pine Script
                  </button>
                </div>
                <div className="strategy-presets">
                  <div className="preset-label">Templates</div>
                  <button
                    type="button" 
                    className="secondary-button"
                    onClick={() => {
                      setStrategyType("pine_script");
                      setPineScript(kemaOptionTemplate);
                      setActiveCodeTab("pine");
                      setIsCodePanelOpen(true);
                      toast.success("Loaded KEMA adaptive template");
                    }}
                  >
                    Load KEMA adaptive template
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setStrategyType("pine_script");
                      setPineScript(emaAtrBreakoutTemplate);
                      setActiveCodeTab("pine");
                      setIsCodePanelOpen(true);
                      toast.success("Loaded EMA breakout template (toggle KEMA inside)");
                    }}
                  >
                    Load EMA breakout template (KEMA toggle)
                  </button>
                </div>
              </section>
            </div>
          )}
        </aside>

        <main className="main-panel">
          <section className="chart-card">
            <div className="card-header">
              <div className="card-heading">
                <h2>{selectedSymbol ? `${selectedSymbol} · ${selectedTimeframe}` : "Price Chart"}</h2>
                <span>{candles.length} candles loaded</span>
              </div>
              {indicatorControlsVisible && (
                <div className="indicator-toggle-group" role="group" aria-label="Indicator overlays">
                  {orderedIndicatorNames.map((name) => {
                    const checked = indicatorVisibility[name] ?? true;
                    const label = indicatorDisplayLabels[name] ?? name;
                    const swatchColor = indicatorColorMap[name] ?? indicatorPalette[0];
                    return (
                      <label key={name} className="indicator-toggle" title={name}>
                        <span
                          className="indicator-color"
                          style={{ backgroundColor: swatchColor }}
                          aria-hidden="true"
                        />
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => handleIndicatorToggle(name, event.target.checked)}
                        />
                        <span className="indicator-label">{label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <CandlestickChart
              candles={candles}
              trades={executedTrades}
              indicatorLines={filteredIndicatorLines}
              indicatorColors={indicatorColorMap}
              focusRequest={chartFocusRequest}
              onFocusHandled={clearChartFocusRequest}
              onHoverCandle={setHoverCandle}
              onSelectCandle={(candle) => {
                setSelectedCandle(candle);
                if (candle) {
                  setHoverCandle(candle);
                }
              }}
            />
            {(hoverCandle || selectedCandle) && (() => {
              const referenceCandle = selectedCandle ?? hoverCandle;
              if (!referenceCandle) {
                return null;
              }
              const percentChange = ((referenceCandle.close - referenceCandle.open) / referenceCandle.open) * 100;
              const candleUnix = toUnixSeconds(referenceCandle.timestamp);
              const entry = executedTrades.find((trade) => toUnixSeconds(trade.entryTime) === candleUnix);
              const exit = executedTrades.find((trade) => toUnixSeconds(trade.exitTime) === candleUnix);

              return (
              <div className={`candle-inspector ${selectedCandle ? "pinned" : ""}`}>
                <div className="inspector-header">
                  <div>
                    <span className="inspector-title">Candle details</span>
                    <span className="inspector-time">{formatDateTime(referenceCandle.timestamp)}</span>
                  </div>
                  {selectedCandle && (
                    <button type="button" className="icon-button" onClick={() => setSelectedCandle(null)}>
                      ✕
                    </button>
                  )}
                </div>
                <div className="inspector-grid">
                  <div>
                    <span className="label">Open</span>
                    <span>{formatPrice(referenceCandle.open)}</span>
                  </div>
                  <div>
                    <span className="label">High</span>
                    <span>{formatPrice(referenceCandle.high)}</span>
                  </div>
                  <div>
                    <span className="label">Low</span>
                    <span>{formatPrice(referenceCandle.low)}</span>
                  </div>
                  <div>
                    <span className="label">Close</span>
                    <span>{formatPrice(referenceCandle.close)}</span>
                  </div>
                  <div>
                    <span className="label">Volume</span>
                    <span>{formatVolume(referenceCandle.volume)}</span>
                  </div>
                  <div>
                    <span className="label">Change</span>
                    <span>{formatPercent(percentChange)}</span>
                  </div>
                </div>
                <div className="inspector-strategy">
                  <span className="label">Strategy impact</span>
                  {executedTrades.length === 0 ? (
                    <span className="muted">No trades executed</span>
                  ) : entry || exit ? (
                    <ul>
                      {entry && (
                        <li>
                          <strong>Entry</strong> · {entry.direction === "long" ? "Long" : "Short"} via {entry.entrySignal || "n/a"} @ {formatPrice(entry.entryPrice)} · Size {formatPositionSize(entry.positionSize)}
                        </li>
                      )}
                      {exit && (
                        <li>
                          <strong>Exit</strong> · {exit.exitSignal || "n/a"} @ {formatPrice(exit.exitPrice)} · PnL {formatPrice(exit.profit)} · Run-up {formatPrice(exit.runUp)} · Drawdown {formatPrice(exit.drawDown)} · Cum PnL {formatPrice(exit.cumulativeProfit)}
                        </li>
                      )}
                    </ul>
                  ) : (
                    <span className="muted">Strategy held position steady</span>
                  )}
                </div>
              </div>
              );
            })()}
          </section>

          {backtestResult && runConfigDetails.length > 0 && (
            <section className="config-card">
              <div className="card-header">
                <h3>Run Configuration</h3>
                <span>
                  {(backtestResult?.round_quantity ?? roundQuantity)
                    ? "Lot rounding on"
                    : "Lot rounding off"}
                  {" · "}
                  {(backtestResult?.execution_model ?? executionModel) === "close_signal_bar"
                    ? "Exec @ close"
                    : "Exec @ next open"}
                </span>
              </div>
              <div className="config-grid">
                {runConfigDetails.map(({ key, label, value }) => (
                  <div key={key} className="config-item">
                    <span className="label">{label}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {showAnalytics && <MetricsPanel metrics={backtestResult} />}

          {showAnalytics && (
            <>
              <div className="analytics-toolbar">
                <span className="toolbar-label">Panels</span>
                <div className="toolbar-buttons">
                  {analyticsViewOptions.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      className={`toolbar-button ${analyticsView === key ? "active" : ""}`}
                      onClick={() => setAnalyticsView(key)}
                      aria-pressed={analyticsView === key}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <section className={`analytics-stack ${showAllPanels ? "show-all" : ""}`}>
                {showAllPanels ? (
                  <>
                    <div className="analytics-row">
                      {equityPanelVisible && (
                        <div className="equity-card">
                          <div className="card-header">
                            <h3>Equity Curve</h3>
                          </div>
                          <EquityCurveChart data={backtestResult?.equityCurve ?? []} />
                        </div>
                      )}
                      {historyPanelVisible && (
                        <div className="trades-card">
                          <div className="card-header">
                            <h3>Trade History</h3>
                          </div>
                          <TradeHistoryTable trades={executedTrades} onJumpToTrade={handleJumpToTrade} />
                        </div>
                      )}
                    </div>
                    {analysisPanelVisible && <TradesAnalysisPanel trades={executedTrades} />}
                  </>
                ) : (
                  <>
                    {equityPanelVisible && (
                      <div className="equity-card">
                        <div className="card-header">
                          <h3>Equity Curve</h3>
                        </div>
                        <EquityCurveChart data={backtestResult?.equityCurve ?? []} />
                      </div>
                    )}
                    {historyPanelVisible && (
                      <div className="trades-card">
                        <div className="card-header">
                          <h3>Trade History</h3>
                        </div>
                        <TradeHistoryTable trades={executedTrades} onJumpToTrade={handleJumpToTrade} />
                      </div>
                    )}
                    {analysisPanelVisible && <TradesAnalysisPanel trades={executedTrades} />}
                  </>
                )}
              </section>
            </>
          )}
        </main>

        <aside className={`right-panel ${isCodePanelOpen ? "" : "collapsed"}`} aria-hidden={!isCodePanelOpen}>
          <div className="panel-toggle">
            <button onClick={() => setIsCodePanelOpen((state) => !state)}>
              {isCodePanelOpen ? "➡" : "⬅"}
            </button>
            <span>Strategy Code</span>
          </div>
          {isCodePanelOpen && (
            <div className="code-panel">
              <div className="code-tabs">
                <button className={activeCodeTab === "json" ? "active" : ""} onClick={() => setActiveCodeTab("json")}>
                  JSON
                </button>
                <button className={activeCodeTab === "pine" ? "active" : ""} onClick={() => setActiveCodeTab("pine")}>
                  Pine Script
                </button>
              </div>
              {activeCodeTab === "json" ? (
                <>
                  <textarea value={jsonEditorValue} onChange={(event) => setJsonEditorValue(event.target.value)} rows={20} />
                  <button type="button" className="secondary-button" onClick={applyJsonEditor}>
                    Apply JSON
                  </button>
                </>
              ) : (
                <textarea value={pineScript} onChange={(event) => setPineScript(event.target.value)} rows={20} />
              )}
            </div>
          )}
        </aside>
      </div>

      {isStrategyModalOpen && (
        <div
          className="strategy-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Strategy configuration workspace"
          onClick={closeStrategyModal}
        >
          <div className="strategy-modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="strategy-modal-header">
              <div>
                <h2>Strategy Workspace</h2>
                <p>Adjust moving averages, Pine scripts, and interactive inputs side-by-side.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close strategy workspace"
                onClick={closeStrategyModal}
              >
                ✕
              </button>
            </header>
            <div className="strategy-modal-body">{strategyConfigContent}</div>
            <footer className="strategy-modal-footer">
              <button type="button" className="secondary-button" onClick={closeStrategyModal}>
                Close
              </button>
              <button type="button" className="primary-button" onClick={closeStrategyModal}>
                Done
              </button>
            </footer>
          </div>
        </div>
      )}

      {isImportModalOpen && (
        <div
          className="import-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Import dataset CSV"
          onClick={closeImportModal}
        >
          <div className="import-modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="import-modal-header">
              <div>
                <h2>Import price data</h2>
                <p>Upload a TradingView-exported CSV to add or replace a dataset.</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close import dialog" onClick={closeImportModal}>
                ✕
              </button>
            </header>
            <div className="import-modal-body">
              <form onSubmit={handleUpload} className="upload-form">
                <label htmlFor="upload-symbol">Symbol</label>
                <input
                  id="upload-symbol"
                  name="symbol"
                  value={uploadSymbol}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setUploadSymbol(event.target.value.toUpperCase())}
                  placeholder="e.g. BTCUSDT"
                  required
                />

                <label htmlFor="upload-timeframe">Timeframe</label>
                <select
                  id="upload-timeframe"
                  name="timeframe"
                  value={uploadTimeframe}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setUploadTimeframe(event.target.value)}
                >
                  {timeframeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>

                <label className="file-input">
                  <span>CSV file</span>
                  <input type="file" name="file" accept=".csv" required />
                </label>
                <p className="panel-hint">
                  Columns expected: time, open, high, low, close (TradingView export supported).
                </p>
                <div className="import-modal-footer">
                  <button type="button" className="secondary-button" onClick={closeImportModal}>
                    Cancel
                  </button>
                  <button type="submit" className="primary-button" disabled={isUploading}>
                    {isUploading ? "Uploading…" : "Upload & Replace"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BacktestTradingPage;
