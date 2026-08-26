"""因子研究引擎：受限因子 DSL + IC/IR + 分层回测 + 衰减分析。

因子源码保持 Python 函数外形，便于用户书写，例如::

    def factor(df):
        close = df["close"]
        return close.pct_change(20) / close.pct_change().rolling(20).std()

但它不是任意 Python：这里解析 AST 并解释一个很小的、纯数值的表达式子集，
绝不 ``exec`` 用户代码，也不暴露 pandas/numpy 的文件、网络或序列化 API。
"""
from __future__ import annotations

import ast
import operator
from typing import Any, Callable

import numpy as np
import pandas as pd


class FactorCodeError(ValueError):
    """因子代码不合法。"""


# 本地分析库目前只持久化日收盘价。禁止把收盘价复制成 OHLCV 后继续研究，
# 否则会把并不存在的成交量/高低价信息伪装成真实因子输入。
_COLUMNS = {"close"}
_SERIES_METHODS = {
    "abs", "clip", "diff", "ewm", "fillna", "mean", "median", "min", "max",
    "pct_change", "rank", "replace", "rolling", "shift", "std", "sum",
}
_ROLLING_METHODS = {"mean", "median", "min", "max", "std", "sum"}
_EWM_METHODS = {"mean", "std"}
_NUMPY_FUNCTIONS = {"abs", "clip", "log", "maximum", "minimum", "sign", "sqrt", "where"}
_BINOPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
}
_CMPOPS: dict[type[ast.cmpop], Callable[[Any, Any], Any]] = {
    ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Gt: operator.gt,
    ast.GtE: operator.ge, ast.Lt: operator.lt, ast.LtE: operator.le,
}


def _factor_error(node: ast.AST, message: str) -> FactorCodeError:
    return FactorCodeError(f"第 {getattr(node, 'lineno', '?')} 行：{message}")


def _validate_factor_tree(tree: ast.Module) -> ast.FunctionDef:
    """只接受 ``def factor(df):`` 中的局部赋值和一个 return。"""
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise FactorCodeError("因子必须只包含一个 def factor(df) 函数")
    fn = tree.body[0]
    if fn.name != "factor" or fn.decorator_list or fn.returns is not None:
        raise _factor_error(fn, "只允许未装饰的 def factor(df) 函数")
    args = fn.args
    if len(args.args) != 1 or args.args[0].arg != "df" or any((args.posonlyargs, args.kwonlyargs, args.vararg, args.kwarg, args.defaults, args.kw_defaults)):
        raise _factor_error(fn, "factor 只能有一个名为 df 的位置参数")
    if not fn.body or not isinstance(fn.body[-1], ast.Return) or fn.body[-1].value is None:
        raise _factor_error(fn, "函数最后必须 return 一个因子序列")
    declared = {"df"}
    for statement in fn.body[:-1]:
        if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
            raise _factor_error(statement, "只允许形如 x = 表达式 的局部赋值")
        target = statement.targets[0].id
        if target in {"df", "pd", "np"} or target.startswith("_"):
            raise _factor_error(statement, "局部变量名不允许覆盖保留名称或以下划线开头")
        _validate_expr(statement.value, declared)
        declared.add(target)
    _validate_expr(fn.body[-1].value, declared)
    return fn


def _validate_expr(node: ast.AST, names: set[str]) -> None:
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float, bool, str)) or node.value is None:
            if isinstance(node.value, str) and node.value not in _COLUMNS:
                raise _factor_error(node, "字符串仅可用于 close 列名")
            return
        raise _factor_error(node, "不支持该常量类型")
    if isinstance(node, ast.Name):
        if node.id not in names and node.id != "np":
            raise _factor_error(node, f"未定义或不允许的名称 {node.id}")
        return
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        _validate_expr(node.left, names); _validate_expr(node.right, names); return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        _validate_expr(node.operand, names); return
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _CMPOPS:
        _validate_expr(node.left, names); _validate_expr(node.comparators[0], names); return
    if isinstance(node, ast.IfExp):
        _validate_expr(node.test, names); _validate_expr(node.body, names); _validate_expr(node.orelse, names); return
    if isinstance(node, (ast.List, ast.Tuple)):
        for element in node.elts:
            _validate_expr(element, names)
        return
    if isinstance(node, ast.Subscript):
        if not isinstance(node.value, ast.Name) or node.value.id != "df" or not isinstance(node.slice, ast.Constant) or node.slice.value not in _COLUMNS:
            raise _factor_error(node, "当前本地数据仅支持 df['close']")
        return
    if isinstance(node, ast.Call):
        _validate_call(node, names)
        return
    raise _factor_error(node, "表达式包含不允许的语法")


def _validate_call(node: ast.Call, names: set[str]) -> None:
    if any(keyword.arg is None or keyword.arg.startswith("_") for keyword in node.keywords):
        raise _factor_error(node, "不支持 **kwargs 或私有参数")
    if isinstance(node.func, ast.Attribute):
        if node.func.attr.startswith("_"):
            raise _factor_error(node, "不允许私有属性")
        if isinstance(node.func.value, ast.Name) and node.func.value.id == "np":
            if node.func.attr not in _NUMPY_FUNCTIONS:
                raise _factor_error(node, f"np.{node.func.attr} 不在允许列表中")
        elif node.func.attr not in _SERIES_METHODS | _ROLLING_METHODS | _EWM_METHODS:
            raise _factor_error(node, f"方法 {node.func.attr} 不在允许列表中")
        else:
            _validate_expr(node.func.value, names)
    else:
        raise _factor_error(node, "只允许调用受限的 Series/rolling/ewm/np 方法")
    for argument in node.args:
        _validate_expr(argument, names)
    for keyword in node.keywords:
        _validate_expr(keyword.value, names)


def _evaluate_expr(node: ast.AST, env: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return env[node.id]
    if isinstance(node, ast.BinOp):
        return _BINOPS[type(node.op)](_evaluate_expr(node.left, env), _evaluate_expr(node.right, env))
    if isinstance(node, ast.UnaryOp):
        value = _evaluate_expr(node.operand, env)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.Compare):
        return _CMPOPS[type(node.ops[0])](_evaluate_expr(node.left, env), _evaluate_expr(node.comparators[0], env))
    if isinstance(node, ast.IfExp):
        return _evaluate_expr(node.body if bool(_evaluate_expr(node.test, env)) else node.orelse, env)
    if isinstance(node, ast.List):
        return [_evaluate_expr(element, env) for element in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_evaluate_expr(element, env) for element in node.elts)
    if isinstance(node, ast.Subscript):
        return env["df"][node.slice.value]
    if isinstance(node, ast.Call):
        args = [_evaluate_expr(argument, env) for argument in node.args]
        kwargs = {keyword.arg: _evaluate_expr(keyword.value, env) for keyword in node.keywords}
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == "np":
            return getattr(np, node.func.attr)(*args, **kwargs)
        receiver = _evaluate_expr(node.func.value, env)
        return getattr(receiver, node.func.attr)(*args, **kwargs)
    raise FactorCodeError("因子表达式无法执行")


def compile_factor(code: str) -> Callable[[pd.DataFrame], pd.Series]:
    """编译受限因子 DSL；不执行用户提供的 Python 代码。"""
    if not code or not code.strip():
        raise FactorCodeError("因子代码不能为空")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise FactorCodeError(f"语法错误：{exc.msg}（第 {exc.lineno} 行）") from exc
    fn = _validate_factor_tree(tree)
    assignments = [statement for statement in fn.body[:-1] if isinstance(statement, ast.Assign)]
    return_expr = fn.body[-1].value

    def evaluate(df: pd.DataFrame) -> pd.Series:
        if not isinstance(df, pd.DataFrame) or not _COLUMNS.issubset(df.columns):
            raise FactorCodeError("因子输入必须包含 close 列")
        env: dict[str, Any] = {"df": df, "np": np}
        for statement in assignments:
            env[statement.targets[0].id] = _evaluate_expr(statement.value, env)
        return _evaluate_expr(return_expr, env)

    return evaluate


def build_panels(series: dict[str, list[tuple[str, float]]], min_rows: int = 60) -> tuple[pd.DataFrame, dict[str, pd.Series]]:
    """构造收盘价面板（日期×标的）；当前因子研究只使用真实 close 数据。"""
    closes = {}
    for symbol, points in series.items():
        if len(points) >= min_rows:
            closes[symbol] = pd.Series({d: float(p) for d, p in points}).sort_index()
    return pd.DataFrame(closes).sort_index().dropna(how="all"), closes


def evaluate_factor(factor_fn: Callable[[pd.DataFrame], pd.Series], closes: dict[str, pd.Series], horizon: int = 1, quantiles: int = 5) -> dict[str, Any]:
    """在横截面上评估因子: IC 序列/IR/胜率/t 值、分层回测、多期衰减。"""
    factor_values: dict[str, pd.Series] = {}
    for symbol, close in closes.items():
        df = pd.DataFrame({"close": close})
        try:
            values = factor_fn(df)
        except Exception as exc:  # noqa: BLE001
            raise FactorCodeError(f"{symbol} 上计算失败：{type(exc).__name__}: {exc}") from exc
        if values is None or not isinstance(values, (pd.Series, list, tuple, np.ndarray)):
            raise FactorCodeError(f"{symbol} 的 factor() 返回值必须是 Series")
        values = pd.Series(values, index=getattr(values, "index", close.index)) if not isinstance(values, pd.Series) else values
        values = pd.to_numeric(values, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
        if len(values) >= 30:
            factor_values[symbol] = values
    if len(factor_values) < 3:
        raise FactorCodeError(f"可用标的不足（{len(factor_values)} 个），每个标的至少需要 30 个有效因子值")

    fwd = {s: c.pct_change(horizon).shift(-horizon) for s, c in closes.items()}
    dates = sorted(set().union(*[set(v.index) for v in factor_values.values()]))
    ic_list: list[tuple[str, float]] = []
    layer_curves: list[list[float]] = [[] for _ in range(quantiles)]
    for date in dates:
        pairs = [(s, float(values.loc[date]), float(fwd[s].loc[date])) for s, values in factor_values.items() if date in values.index and date in fwd[s].index and np.isfinite(values.loc[date]) and np.isfinite(fwd[s].loc[date])]
        if len(pairs) < 3:
            continue
        factors = np.array([p[1] for p in pairs]); returns = np.array([p[2] for p in pairs])
        if np.std(factors) == 0 or np.std(returns) == 0:
            continue
        rho = float(np.corrcoef(np.argsort(np.argsort(factors)), np.argsort(np.argsort(returns)))[0, 1])
        if not np.isfinite(rho):
            continue
        ic_list.append((date, rho))
        for layer_idx, members in enumerate(np.array_split(np.argsort(factors), quantiles)):
            layer_curves[layer_idx].append(float(np.mean(returns[members])))
    if len(ic_list) < 10:
        raise FactorCodeError("有效 IC 样本不足（<10 期），请延长历史或放宽条件")

    ics = np.array([v for _, v in ic_list]); ic_mean = float(ics.mean()); ic_std = float(ics.std(ddof=1))
    result: dict[str, Any] = {"available": True, "symbols": sorted(factor_values), "periods": len(ics), "first_date": ic_list[0][0], "last_date": ic_list[-1][0], "ic_mean": ic_mean, "ic_ir": float(ic_mean / ic_std) if ic_std > 0 else 0.0, "ic_positive_ratio": float((ics > 0).mean()), "t_stat": float(ic_mean / (ic_std / np.sqrt(len(ics)))) if ic_std > 0 else 0.0, "ic_series_tail": [{"date": d, "ic": round(v, 4)} for d, v in ic_list[-40:]]}
    base = [curve for curve in layer_curves if curve]
    if base:
        length = min(len(curve) for curve in base); layers = []
        for idx in range(quantiles):
            rets = np.array(layer_curves[idx][-length:]); cum = float(np.prod(1 + rets))
            ann = cum ** (252 / max(length * horizon, 1)) - 1 if cum > 0 else -1.0
            vol = float(rets.std(ddof=1) * np.sqrt(252 / horizon)) if len(rets) > 2 else 0.0
            layers.append({"layer": idx + 1, "annual_return": round(float(ann), 4), "sharpe": round(float(ann / vol), 3) if vol > 0 else 0.0})
        spread = np.array(base[0][-length:]) - np.array(base[-1][-length:]); spr_cum = float(np.prod(1 + spread))
        result["layers"] = layers
        result["long_short_annual"] = round(spr_cum ** (252 / max(length * horizon, 1)) - 1, 4) if spr_cum > 0 else -1.0
    decay = []
    for h in range(1, 6):
        sub = evaluate_ic_only(factor_values, closes, h)
        if np.isfinite(sub):
            decay.append({"horizon": h, "ic": round(sub, 4)})
    result["decay"] = decay
    return result


def evaluate_ic_only(factor_values: dict[str, pd.Series], closes: dict[str, pd.Series], horizon: int) -> float:
    fwd = {s: c.pct_change(horizon).shift(-horizon) for s, c in closes.items()}
    dates = sorted(set().union(*[set(v.index) for v in factor_values.values()])); ics = []
    for date in dates:
        pairs = [(float(values.loc[date]), float(fwd[s].loc[date])) for s, values in factor_values.items() if date in values.index and date in fwd[s].index and np.isfinite(fwd[s].loc[date])]
        if len(pairs) < 3:
            continue
        factors = np.array([p[0] for p in pairs]); returns = np.array([p[1] for p in pairs])
        if np.std(factors) > 0 and np.std(returns) > 0:
            ics.append(np.corrcoef(np.argsort(np.argsort(factors)), np.argsort(np.argsort(returns)))[0, 1])
    return float(np.nanmean(ics)) if len(ics) >= 5 else float("nan")
