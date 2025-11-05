import ast
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Union

from ..schemas import MovingAverageCrossStrategy


class PineScriptParseError(ValueError):
    pass


@dataclass
class KemaOptionConfig:
    ema_length: int
    atr_length: int
    volatility_factor: float
    initial_risk: float
    risk_equity: float
    trade_option: str  # "long_only", "short_only", "both"
    start_date: Optional[datetime]
    end_date: Optional[datetime]

    @property
    def type(self) -> str:
        return "kema_option"

    @property
    def allow_short(self) -> bool:
        return self.trade_option in {"short_only", "both"}


def _extract_int(pattern: str, code: str) -> Optional[int]:
    match = re.search(pattern, code, re.IGNORECASE | re.MULTILINE)
    if not match:
        return None
    return int(match.group(1))


class _InputShim:
    """Simple callable that mimics Pine's input helpers by returning the default value."""

    def __call__(self, first_arg=None, *args, **kwargs):  # type: ignore[override]
        if first_arg is None and "defval" in kwargs:
            return kwargs["defval"]
        return first_arg

    def int(self, first_arg=None, *args, **kwargs):  # type: ignore[override]
        return self(first_arg, *args, **kwargs)

    def float(self, first_arg=None, *args, **kwargs):  # type: ignore[override]
        return self(first_arg, *args, **kwargs)

    def bool(self, first_arg=None, *args, **kwargs):  # type: ignore[override]
        return self(first_arg, *args, **kwargs)

    def string(self, first_arg=None, *args, **kwargs):  # type: ignore[override]
        return self(first_arg, *args, **kwargs)


_ALLOWED_BIN_OPS = {
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Mod,
    ast.Pow,
}


def _safe_eval_expr(expr: str) -> Optional[Union[int, float, str]]:
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return None

    input_shim = _InputShim()
    env = {
        "input": input_shim,
        "math": math,
        "max": max,
        "min": min,
        "abs": abs,
        "floor": math.floor,
    }

    def _evaluate(node: ast.AST) -> Union[int, float, str]:
        if isinstance(node, ast.Constant):
            return node.value  # type: ignore[return-value]
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]  # type: ignore[return-value]
            raise PineScriptParseError(f"Unsupported identifier in expression: {node.id}")
        if isinstance(node, ast.Attribute):
            value = _evaluate(node.value)
            return getattr(value, node.attr)  # type: ignore[return-value]
        if isinstance(node, (ast.List, ast.Tuple)):
            return [_evaluate(element) for element in node.elts]  # type: ignore[return-value]
        if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BIN_OPS:
            left = _evaluate(node.left)
            right = _evaluate(node.right)
            op_type = type(node.op)
            if op_type is ast.Add:
                return left + right  # type: ignore[operator]
            if op_type is ast.Sub:
                return left - right  # type: ignore[operator]
            if op_type is ast.Mult:
                return left * right  # type: ignore[operator]
            if op_type is ast.Div:
                return left / right  # type: ignore[operator]
            if op_type is ast.Mod:
                return left % right  # type: ignore[operator]
            if op_type is ast.Pow:
                return left ** right  # type: ignore[operator]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            operand = _evaluate(node.operand)
            return +operand if isinstance(node.op, ast.UAdd) else -operand  # type: ignore[arg-type]
        if isinstance(node, ast.Call):
            func = _evaluate(node.func)
            args = [_evaluate(arg) for arg in node.args]
            kwargs = {kw.arg: _evaluate(kw.value) for kw in node.keywords if kw.arg}
            return func(*args, **kwargs)  # type: ignore[misc]
        raise PineScriptParseError("Unable to evaluate Pine Script input expression")

    evaluated = _evaluate(tree.body)
    return evaluated


def _extract_assignment(code: str, name: str) -> Optional[str]:
    pattern = rf"^\s*{name}\s*=\s*(.+)$"
    match = re.search(pattern, code, re.MULTILINE)
    if not match:
        return None
    return match.group(1).strip()


def _parse_kema_option(code: str) -> Optional[KemaOptionConfig]:
    required_identifiers = [
        "length_ema",
        "length_atr",
        "volatility_factor",
        "initial_risk",
        "risk_equity",
        "trade_option",
    ]
    if not all(re.search(rf"^\s*{name}\s*=", code, re.MULTILINE) for name in required_identifiers):
        return None

    def _evaluate(name: str) -> Optional[Union[int, float, str]]:
        expr = _extract_assignment(code, name)
        if expr is None:
            return None
        return _safe_eval_expr(expr)

    ema_length = _evaluate("length_ema")
    atr_length = _evaluate("length_atr")
    volatility_factor = _evaluate("volatility_factor")
    initial_risk = _evaluate("initial_risk")
    risk_equity = _evaluate("risk_equity")
    trade_option = _evaluate("trade_option")

    if not all(
        value is not None
        for value in [ema_length, atr_length, volatility_factor, initial_risk, risk_equity, trade_option]
    ):
        raise PineScriptParseError("Unsupported KEMA script: missing required inputs")

    try:
        ema_length_int = int(float(ema_length))
        atr_length_int = int(float(atr_length))
        volatility_factor_float = float(volatility_factor)
        initial_risk_float = float(initial_risk)
        risk_equity_float = float(risk_equity)
        trade_option_str = str(trade_option).strip().lower()
    except (TypeError, ValueError) as exc:
        raise PineScriptParseError("Unsupported KEMA script: invalid numeric inputs") from exc

    trade_option_map = {
        "both": "both",
        "long only": "long_only",
        "short only": "short_only",
    }
    normalized_trade_option = trade_option_map.get(trade_option_str, "both")

    start_year = _evaluate("startYear")
    start_month = _evaluate("startMonth")
    start_day = _evaluate("startDay")
    end_year = _evaluate("endYear")
    end_month = _evaluate("endMonth")
    end_day = _evaluate("endDay")

    def _build_date(year_val, month_val, day_val) -> Optional[datetime]:
        if year_val is None or month_val is None or day_val is None:
            return None
        try:
            return datetime(
                int(float(year_val)),
                int(float(month_val)),
                int(float(day_val)),
                tzinfo=timezone.utc,
            )
        except ValueError:
            return None

    start_date = _build_date(start_year, start_month, start_day)
    end_date = _build_date(end_year, end_month, end_day)

    return KemaOptionConfig(
        ema_length=ema_length_int,
        atr_length=atr_length_int,
        volatility_factor=volatility_factor_float,
        initial_risk=initial_risk_float,
        risk_equity=risk_equity_float,
        trade_option=normalized_trade_option,
        start_date=start_date,
        end_date=end_date,
    )


def parse_pine_script(code: str) -> Union[MovingAverageCrossStrategy, KemaOptionConfig]:
    """Parse supported Pine Script snippets into executable strategy configs."""

    kema_config = _parse_kema_option(code)
    if kema_config is not None:
        return kema_config

    fast = _extract_int(r"fast\w*\s*=\s*input\.int\(\s*(\d+)", code)
    slow = _extract_int(r"slow\w*\s*=\s*input\.int\(\s*(\d+)", code)

    if fast is None or slow is None:
        raise PineScriptParseError(
            "Unsupported Pine Script: only MA crossover or recognised KEMA-Option scripts are supported."
        )

    if slow <= fast:
        raise PineScriptParseError("slow length must be greater than fast length")

    has_crossover = re.search(r"ta\.crossover\(\s*fast\w*,\s*slow\w*\)", code, re.IGNORECASE)
    has_crossunder = re.search(r"ta\.crossunder\(\s*fast\w*,\s*slow\w*\)", code, re.IGNORECASE)

    if not (has_crossover and has_crossunder):
        raise PineScriptParseError(
            "Unsupported Pine Script: both crossover and crossunder rules are required."
        )

    return MovingAverageCrossStrategy(
        type="moving_average_cross",
        fastWindow=fast,
        slowWindow=slow,
        source="close",
        allowShort=False,
    )
