import { Navigate, Route, Routes } from "react-router-dom";
import BacktestTradingPage from "./pages/BacktestTradingPage";

const App = () => {
  return (
    <Routes>
      <Route path="/backtest-trading" element={<BacktestTradingPage />} />
      <Route path="*" element={<Navigate to="/backtest-trading" replace />} />
    </Routes>
  );
};

export default App;
