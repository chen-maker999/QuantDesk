import unittest

from engine import database
from engine.main import MarketPriceRow, _market_data_manifest


class AnalysisBarLineageTest(unittest.TestCase):
    def setUp(self):
        database.initialize()
        with database.connect() as db:
            db.execute("DELETE FROM analysis_bars")
            db.execute("DELETE FROM market_prices")

    def test_persists_real_ohlcv_with_provenance(self):
        database.upsert_analysis_bars([{
            "symbol": "600519", "trade_date": "2025-01-02", "market": "a", "adjust": "qfq", "source": "tencent",
            "open": 1500, "high": 1520, "low": 1490, "close": 1510, "volume": 123456, "amount": 186000000,
        }])
        row = database.read_analysis_bars()[0]
        self.assertEqual(row["symbol"], "600519")
        self.assertEqual(row["adjust"], "qfq")
        self.assertEqual(row["source"], "tencent")
        self.assertEqual(row["volume"], 123456.0)

    def test_rejects_inconsistent_ohlc(self):
        with self.assertRaises(ValueError):
            database.upsert_analysis_bars([{
                "symbol": "BAD", "trade_date": "2025-01-02", "source": "csv",
                "open": 10, "high": 9, "low": 8, "close": 10,
            }])

    def test_csv_bar_schema_normalizes_dates_and_rejects_invalid_range(self):
        row = MarketPriceRow(symbol="600519", date="2025-01-02T15:00:00", close=10, open=9, high=11, low=8)
        self.assertEqual(row.date, "2025-01-02")
        with self.assertRaises(ValueError):
            MarketPriceRow(symbol="600519", date="2025/01/02", close=10)
        with self.assertRaises(ValueError):
            MarketPriceRow(symbol="600519", date="2025-01-02", close=10, open=9, high=8)

    def test_manifest_changes_when_market_data_changes(self):
        with database.connect() as db:
            db.execute("INSERT INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", ("AAA", "2025-01-02", 10.0, "csv"))
        first = _market_data_manifest(["AAA"])
        with database.connect() as db:
            db.execute("UPDATE market_prices SET close=? WHERE symbol=? AND trade_date=?", (11.0, "AAA", "2025-01-02"))
        second = _market_data_manifest(["AAA"])
        self.assertEqual(first["market_prices"]["symbols"][0]["sources"], ["csv"])
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])


if __name__ == "__main__":
    unittest.main()
