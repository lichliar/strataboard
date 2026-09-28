import type { AssetType, Freq } from "../types";

// Tushare api_name serving an asset type's OHLCV quotes — the single source
// of truth shared by DataAdapter.buildTushareRequest (cache filling) and the
// standalone Node CLI (probe command).
//
// Only stock (daily/weekly/monthly) and index (index_daily/index_weekly/
// index_monthly) have native W/M endpoints. Everything else — fund
// (fund_daily), ofund (fund_nav), nhindex (fut_index_daily), hk (hk_daily),
// gbindex (index_global), cb (cb_daily), fut (fut_daily), fx (fx_daily),
// sw (sw_daily), custom — is daily-only: the plugin caches daily rows and
// resamples to W/M at read time (see DataAdapter.maybeResample), so freq is
// ignored for them here.
export function tushareQuoteApiName(assetType: AssetType, freq: Freq): string {
  switch (assetType) {
    case "stock":
      return freq === "W" ? "weekly" : freq === "M" ? "monthly" : "daily";
    case "index":
      return freq === "W" ? "index_weekly" : freq === "M" ? "index_monthly" : "index_daily";
    case "fund":
      return "fund_daily";
    case "ofund":
      // 场外基金只有净值（fund_nav）；W/M 由读取端重采样。
      return "fund_nav";
    case "nhindex":
      // 南华期货指数只有日线；W/M 由读取端重采样。
      return "fut_index_daily";
    case "hk":
      // 港股只有日线（hk_daily）；W/M 由读取端重采样。
      return "hk_daily";
    case "gbindex":
      // 国际指数只有日线（index_global）；W/M 由读取端重采样。
      return "index_global";
    case "cb":
      // 可转债只有日线（cb_daily）；W/M 由读取端重采样。
      return "cb_daily";
    case "fut":
      // 期货合约只有日线（fut_daily）；W/M 由读取端重采样。
      return "fut_daily";
    case "fx":
      // 外汇只有日线（fx_daily，bid 侧 OHLC）；W/M 由读取端重采样。
      return "fx_daily";
    case "sw":
      // 申万行业指数只有日线（sw_daily）；W/M 由读取端重采样。
      return "sw_daily";
    case "custom":
      // Custom sources bypass Tushare entirely (see DataAdapter.fetchOhlcv);
      // reaching here is a caller bug.
      throw new Error(`tushareQuoteApiName: asset type "custom" has no Tushare quote API.`);
  }
}
