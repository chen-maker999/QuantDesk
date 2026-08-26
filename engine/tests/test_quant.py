import numpy as np
import unittest

from engine.quant import AlphaEnsemble, backtest_signal, optimize_portfolio, risk_report


class QuantTests(unittest.TestCase):
    def test_backtest_lags_signal_and_returns_metrics(self):
        rng = np.random.default_rng(7)
        returns = rng.normal(.0004, .01, 120)
        signals = np.sign(np.roll(returns, -1))
        result = backtest_signal(returns.tolist(), signals.tolist())
        self.assertEqual(len(result["equity_curve"]), 120)
        self.assertTrue(result["assumptions"]["point_in_time"])

    def test_risk_report_orders_var_and_cvar(self):
        returns = np.random.default_rng(9).normal(0, .012, 250).tolist()
        result = risk_report(returns)
        self.assertGreaterEqual(result["cvar"], result["var"])

    def test_risk_report_counts_first_period_drawdown(self):
        result = risk_report([-.10] + [0.0] * 19)
        self.assertAlmostEqual(result["max_drawdown"], -.10)

    def test_optimizer_weights_sum_to_one(self):
        rng = np.random.default_rng(11)
        history = rng.normal(.0003, .01, (160, 10))
        result = optimize_portfolio([.0004] * 10, history.tolist(), max_weight=.15)
        self.assertAlmostEqual(sum(result["weights"]), 1, places=4)
        self.assertLessEqual(max(result["weights"]), .151)

    def test_optimizer_rejects_infeasible_max_weight(self):
        history = np.random.default_rng(4).normal(.0002, .01, (50, 2))
        with self.assertRaises(ValueError):
            optimize_portfolio([.0002, .0003], history.tolist(), max_weight=.10)

    def test_ensemble_scaler_does_not_fit_validation_observations(self):
        class TrackingScaler:
            def __init__(self):
                self.fit_inputs = []

            def fit(self, values):
                self.fit_inputs.append(np.asarray(values).copy())
                return self

            def transform(self, values):
                return np.asarray(values)

            def fit_transform(self, values):
                return self.fit(values).transform(values)

        class ConstantModel:
            def fit(self, _x, _y):
                return self

            def predict(self, values):
                return np.zeros(len(values))

        x = np.arange(150, dtype=float).reshape(50, 3)
        ensemble = AlphaEnsemble()
        scaler = TrackingScaler()
        ensemble.scaler = scaler
        ensemble.models = {"constant": ConstantModel()}
        ensemble.fit_predict(x, np.linspace(0, 1, len(x)), x[-2:])
        split = max(int(len(x) * .78), 30)
        np.testing.assert_array_equal(scaler.fit_inputs[0], x[:split])
        np.testing.assert_array_equal(scaler.fit_inputs[-1], x)


if __name__ == "__main__":
    unittest.main()
