import { BacktestResponse } from "../api/types";

type Props = {
  metrics?: BacktestResponse;
};

const METRIC_LABELS: Record<keyof Pick<BacktestResponse, "totalProfit" | "roiPercent" | "maxDrawdown" | "winrate" | "numberOfTrades">, string> = {
  totalProfit: "Total Profit",
  roiPercent: "ROI %",
  maxDrawdown: "Max Drawdown %",
  winrate: "Win Rate %",
  numberOfTrades: "# Trades",
};

const MetricsPanel = ({ metrics }: Props) => {
  if (!metrics) {
    return (
      <div className="metrics-panel empty">
        <p>No backtest results yet. Configure your strategy and run a backtest.</p>
      </div>
    );
  }

  return (
    <div className="metrics-panel">
      {Object.entries(METRIC_LABELS).map(([key, label]) => {
        const value = metrics[key as keyof typeof METRIC_LABELS];
        const formatted =
          typeof value === "number" && key !== "numberOfTrades" ? value.toFixed(2) : value;
        return (
          <div className="metric-card" key={key}>
            <span className="metric-label">{label}</span>
            <span className="metric-value">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
};

export default MetricsPanel;
