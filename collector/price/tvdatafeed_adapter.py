"""Fetch completed and current 4H/1D bars from TradingView through rongardF/tvdatafeed.

The script intentionally emits normalized JSON to stdout. The TypeScript
orchestrator owns persistence, deduplication, manifest updates and stale-data
handling. Anonymous TradingView access is the default; credentials are only
used when both optional environment variables are explicitly provided.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=os.getenv("TV_SOURCE_SYMBOL", "GOLD.F"))
    parser.add_argument("--exchange", default=os.getenv("TV_SOURCE_EXCHANGE", "BLACKBULL"))
    parser.add_argument("--timeframe", choices=["4H", "1D"], required=True)
    parser.add_argument("--bars", type=int, default=5000)
    return parser.parse_args()


def interval_for(name: str):
    from tvDatafeed import Interval

    return {
        "4H": Interval.in_4_hour,
        "1D": Interval.in_daily,
    }[name]


def main() -> int:
    args = parse_args()
    try:
        from tvDatafeed import TvDatafeed
    except Exception as exc:  # pragma: no cover - exercised in runner setup
        print(f"tvdatafeed import failed: {exc}", file=sys.stderr)
        return 2

    username = os.getenv("TV_USERNAME")
    password = os.getenv("TV_PASSWORD")
    tv = TvDatafeed(username, password) if username and password else TvDatafeed()
    frame = tv.get_hist(
        symbol=args.symbol,
        exchange=args.exchange,
        interval=interval_for(args.timeframe),
        n_bars=min(max(args.bars, 1), 5000),
        extended_session=False,
    )
    if frame is None or frame.empty:
        print("No price bars returned", file=sys.stderr)
        return 3

    source_timezone_name = os.getenv("TV_SOURCE_TIMEZONE", "America/Chicago")
    now_utc = datetime.now(timezone.utc)
    rows = []
    for index, row in frame.iterrows():
        time_value = index.to_pydatetime()
        # tvdatafeed builds its DataFrame with datetime.fromtimestamp(), which
        # returns a naive datetime in the runner's local timezone.  Attaching
        # the exchange timezone here shifts the epoch whenever the runner is
        # not in Chicago (for example Bangkok or GitHub's UTC runners).  Let
        # Python interpret the naive value in the host timezone first, then
        # convert the recovered instant to UTC.
        if time_value.tzinfo is None:
            time_value = time_value.astimezone()
        time_value = time_value.astimezone(timezone.utc)
        if time_value > now_utc:
            continue
        time_iso = time_value.isoformat().replace("+00:00", "Z")
        close_value = time_value + (timedelta(hours=4) if args.timeframe == "4H" else timedelta(days=1))
        close_iso = close_value.isoformat().replace("+00:00", "Z")
        rows.append({
            "time": time_iso,
            "closeTime": close_iso,
            "symbol": "GC",
            "timeframe": args.timeframe,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]) if row.get("volume") is not None else None,
            "source": f"{args.exchange}:{args.symbol}",
            "sourceTimezone": source_timezone_name,
            # TradingView may return the most recently completed candle and the
            # current open candle. Keep both; the TypeScript chart/model filters
            # open bars while the dashboard can still report the current date.
            "isClosed": close_value <= now_utc,
        })
    payload = {
        "schemaVersion": 1,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "symbol": "GC",
        "timeframe": args.timeframe,
        "source": f"{args.exchange}:{args.symbol}",
        "bars": rows,
    }
    print(json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
