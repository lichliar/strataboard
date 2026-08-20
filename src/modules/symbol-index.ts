import { Notice } from "obsidian";
import { ASSET_TYPE_LABELS, type AssetType, type SymbolItem } from "../types";
import { formatDate } from "../utils/date";
import { SqliteCache } from "./sqlite-cache";
import { TushareApiClient } from "./tushare-api-client";

interface SymbolIndexOptions {
  cache: SqliteCache;
  token: string;
  refreshIntervalDays: number;
}

// Nanhua futures indices (Tushare fut_index_daily, doc_id=468). Tushare has
// no basic-info endpoint for them, so the catalog is hardcoded from the
// official list (8 composite/sector indices + 50 single-variety indices).
// Defunct varieties (e.g. BB 胶合板) stay in the list — their quotes simply
// stop updating.
const NANHUA_INDEX_LIST: SymbolItem[] = [
  ["NHAI", "南华农产品指数"],
  ["NHCI", "南华商品指数"],
  ["NHECI", "南华能化指数"],
  ["NHFI", "南华黑色指数"],
  ["NHII", "南华工业品指数"],
  ["NHMI", "南华金属指数"],
  ["NHNFI", "南华有色金属"],
  ["NHPMI", "南华贵金属指数"],
  ["A", "南华连大豆指数"],
  ["AG", "南华沪银指数"],
  ["AL", "南华沪铝指数"],
  ["AP", "南华郑苹果指数"],
  ["AU", "南华沪黄金指数"],
  ["BB", "南华连胶合板指数"],
  ["BU", "南华沪石油沥青指数"],
  ["C", "南华连玉米指数"],
  ["CF", "南华郑棉花指数"],
  ["CS", "南华连玉米淀粉指数"],
  ["CU", "南华沪铜指数"],
  ["CY", "南华棉纱指数"],
  ["ER", "南华郑籼稻指数"],
  ["FB", "南华连纤维板指数"],
  ["FG", "南华郑玻璃指数"],
  ["FU", "南华沪燃油指数"],
  ["HC", "南华沪热轧卷板指数"],
  ["I", "南华连铁矿石指数"],
  ["J", "南华连焦炭指数"],
  ["JD", "南华连鸡蛋指数"],
  ["JM", "南华连焦煤指数"],
  ["JR", "南华郑粳稻指数"],
  ["L", "南华连乙烯指数"],
  ["LR", "南华郑晚籼稻指数"],
  ["M", "南华连豆粕指数"],
  ["ME", "南华郑甲醇指数"],
  ["NI", "南华沪镍指数"],
  ["P", "南华连棕油指数"],
  ["PB", "南华沪铅指数"],
  ["PP", "南华连聚丙烯指数"],
  ["RB", "南华沪螺钢指数"],
  ["RM", "南华郑菜籽粕指数"],
  ["RO", "南华郑菜油指数"],
  ["RS", "南华郑油菜籽指数"],
  ["RU", "南华沪天胶指数"],
  ["SC", "南华原油指数"],
  ["SF", "南华郑硅铁指数"],
  ["SM", "南华郑锰硅指数"],
  ["SN", "南华沪锡指数"],
  ["SP", "南华纸浆指数"],
  ["SR", "南华郑白糖指数"],
  ["TA", "南华郑精对苯二甲酸指数"],
  ["TC", "南华郑动力煤指数"],
  ["V", "南华连聚氯乙烯指数"],
  ["WR", "南华沪线材指数"],
  ["WS", "南华郑强麦指数"],
  ["Y", "南华连豆油指数"],
  ["ZN", "南华沪锌指数"],
].map(([symbol, name]) => ({
  tsCode: `${symbol}.NH`,
  symbol,
  name,
  exchange: "NH",
  assetType: "nhindex" as AssetType,
}));

// Global indices (Tushare index_global, doc_id=211). Tushare has no
// basic-info endpoint for them, so the catalog is hardcoded from the official
// list (21 indices). Their ts_codes are bare — no ".XX" suffix.
const GLOBAL_INDEX_LIST: SymbolItem[] = [
  ["XIN9", "富时中国A50指数"],
  ["HSI", "恒生指数"],
  ["HKTECH", "恒生科技指数"],
  ["HKAH", "恒生AH股H指数"],
  ["DJI", "道琼斯工业指数"],
  ["SPX", "标普500指数"],
  ["IXIC", "纳斯达克指数"],
  ["FTSE", "富时100指数"],
  ["FCHI", "法国CAC40指数"],
  ["GDAXI", "德国DAX指数"],
  ["N225", "日经225指数"],
  ["KS11", "韩国综合指数"],
  ["AS51", "澳大利亚标普200指数"],
  ["SENSEX", "印度孟买SENSEX指数"],
  ["IBOVESPA", "巴西IBOVESPA指数"],
  ["RTS", "俄罗斯RTS指数"],
  ["TWII", "台湾加权指数"],
  ["CKLSE", "马来西亚指数"],
  ["SPTSX", "加拿大S&P/TSX指数"],
  ["CSX5P", "STOXX欧洲50指数"],
  ["RUT", "罗素2000指数"],
].map(([symbol, name]) => ({
  tsCode: symbol,
  symbol,
  name,
  exchange: "GL",
  assetType: "gbindex" as AssetType,
}));

export class SymbolIndex {
  private client: TushareApiClient;
  private cache: SqliteCache;
  private refreshIntervalDays: number;

  constructor(options: SymbolIndexOptions) {
    this.client = new TushareApiClient(options.token);
    this.cache = options.cache;
    this.refreshIntervalDays = options.refreshIntervalDays;
  }

  setToken(token: string) {
    this.client.setToken(token);
  }

  async search(query: string, assetType: AssetType): Promise<SymbolItem[]> {
    return this.cache.searchSymbols(assetType, query);
  }

  async loadAssetType(assetType: AssetType): Promise<SymbolItem[]> {
    const items = await this.cache.loadSymbols(assetType);

    if (items.length > 0 && !(await this.cache.isSymbolCacheStale(assetType, this.refreshIntervalDays))) {
      return items;
    }

    try {
      const fresh = await this.fetchAssetType(assetType);
      await this.cache.saveSymbols(assetType, fresh);
      return fresh;
    } catch (e) {
      // A stale cache is better than nothing: fall back to it when the
      // refresh fails (network down, bad token, ...).
      if (items.length > 0) {
        console.error(`SymbolIndex: failed to refresh ${assetType} list, using stale cache`, e);
        new Notice(`${ASSET_TYPE_LABELS[assetType]}列表更新失败，使用本地缓存。`);
        return items;
      }
      throw e;
    }
  }

  // Loads stocks, funds, indices, Nanhua indices, HK stocks, global indices,
  // convertible bonds, futures contracts, FX pairs and SW industry indices in
  // parallel for the unified search modal. tx/em have no bulk symbol list —
  // they are searched remotely per keystroke (RemoteQuoteSearchModal).
  async loadAll(): Promise<SymbolItem[]> {
    const groups = await Promise.all([
      this.loadAssetType("stock"),
      this.loadAssetType("fund"),
      this.loadAssetType("index"),
      this.loadAssetType("nhindex"),
      this.loadAssetType("hk"),
      this.loadAssetType("gbindex"),
      this.loadAssetType("cb"),
      this.loadAssetType("fut"),
      this.loadAssetType("fx"),
      this.loadAssetType("sw"),
    ]);
    return groups.flat();
  }

  async lookup(tsCode: string, assetType: AssetType): Promise<SymbolItem | undefined> {
    const cached = await this.cache.lookupSymbol(tsCode, assetType);
    if (cached) return cached;

    // tx/em have no bulk list to refresh — their cache rows come from
    // upsertSymbols on pick, and a "refresh" would just wipe them.
    if (assetType === "tx" || assetType === "em") return undefined;

    // Fall back to refreshing the list if the symbol is missing.
    await this.loadAssetType(assetType);
    return this.cache.lookupSymbol(tsCode, assetType);
  }

  private async fetchAssetType(assetType: AssetType): Promise<SymbolItem[]> {
    // Nanhua and global indices have no basic-info endpoint; the catalogs are
    // local.
    if (assetType === "nhindex") {
      return NANHUA_INDEX_LIST;
    }
    if (assetType === "gbindex") {
      return GLOBAL_INDEX_LIST;
    }

    // The four newer Tushare types each need custom field mapping (their
    // basic-info endpoints don't share the stock_basic column layout).
    if (assetType === "cb") return this.fetchCbSymbols();
    if (assetType === "fut") return this.fetchFutSymbols();
    if (assetType === "fx") return this.fetchFxSymbols();
    if (assetType === "sw") return this.fetchSwSymbols();
    // tx/em have no bulk list API; they only exist as remotely searched items.
    if (assetType === "tx" || assetType === "em") return [];

    let apiName = "";
    let params: Record<string, unknown> | undefined;
    switch (assetType) {
      case "stock":
        apiName = "stock_basic";
        break;
      case "fund":
        apiName = "fund_basic";
        break;
      case "index":
        apiName = "index_basic";
        break;
      case "hk":
        // hk_basic has no symbol/exchange columns (market instead) and
        // accepts only ts_code/list_status as filters.
        apiName = "hk_basic";
        params = {
          list_status: "L",
          fields: "ts_code,name,enname,fullname,market,list_date",
        };
        break;
    }

    const response = await this.client.query(
      apiName,
      params ?? {
        exchange: "",
        list_status: "L",
        fields: "ts_code,symbol,name,enname,fullname,exchange,list_date",
      }
    );

    if (!response.data || !response.data.items) {
      return [];
    }

    const fields = response.data.fields;
    const items = response.data.items as unknown[];

    const getIndex = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
    const tsCodeIdx = getIndex("ts_code");
    const symbolIdx = getIndex("symbol");
    const nameIdx = getIndex("name");
    const ennameIdx = getIndex("enname");
    const exchangeIdx = getIndex("exchange") >= 0 ? getIndex("exchange") : getIndex("market");
    const listDateIdx = getIndex("list_date");

    return items.map((item: any) => ({
      tsCode: String(item[tsCodeIdx] ?? ""),
      symbol: symbolIdx >= 0 ? String(item[symbolIdx] ?? "") : String(item[tsCodeIdx] ?? "").split(".")[0],
      name: nameIdx >= 0 ? String(item[nameIdx] ?? "") : "",
      enname: ennameIdx >= 0 ? String(item[ennameIdx] ?? "") : undefined,
      exchange: exchangeIdx >= 0 ? String(item[exchangeIdx] ?? "") : "",
      listDate: listDateIdx >= 0 ? String(item[listDateIdx] ?? "") : undefined,
      assetType,
    }));
  }

  // 可转债 (cb_basic, 2000积分): only live bonds (delist_date empty) are
  // listed; name comes from bond_short_name ("万科转债").
  private async fetchCbSymbols(): Promise<SymbolItem[]> {
    const response = await this.client.query("cb_basic", {
      list_status: "L",
      fields: "ts_code,bond_short_name,stk_short_name,list_date,delist_date",
    });
    if (!response.data?.items) return [];
    const [ts, nm, stk, ld, dd] = ["ts_code", "bond_short_name", "stk_short_name", "list_date", "delist_date"].map(
      (f) => response.data!.fields.findIndex((x) => x.toLowerCase() === f)
    );
    return (response.data.items as any[])
      .filter((item) => !item[dd])
      .map((item) => ({
        tsCode: String(item[ts] ?? ""),
        symbol: String(item[ts] ?? "").split(".")[0],
        name: String(item[nm] ?? ""),
        exchange: String(item[stk] ?? ""), // underlying stock name, e.g. 万科A
        listDate: item[ld] ? String(item[ld]) : undefined,
        assetType: "cb" as AssetType,
      }));
  }

  // 期货 (fut_basic, 2000积分): six exchanges fetched in parallel; only
  // contracts not yet delisted are listed (fut_type=1 普通合约).
  private async fetchFutSymbols(): Promise<SymbolItem[]> {
    const exchanges = ["SHFE", "DCE", "CZCE", "CFFEX", "INE", "GFEX"];
    const today = formatDate(new Date());
    const groups = await Promise.all(
      exchanges.map(async (exchange) => {
        const response = await this.client.query("fut_basic", {
          exchange,
          fut_type: "1",
          fields: "ts_code,symbol,name,list_date,delist_date",
        });
        if (!response.data?.items) return [];
        const [ts, sym, nm, ld, dd] = ["ts_code", "symbol", "name", "list_date", "delist_date"].map((f) =>
          response.data!.fields.findIndex((x) => x.toLowerCase() === f)
        );
        return (response.data.items as any[])
          .filter((item) => !item[dd] || String(item[dd]) >= today)
          .map((item) => ({
            tsCode: String(item[ts] ?? ""),
            symbol: String(item[sym] ?? ""),
            name: String(item[nm] ?? ""),
            exchange,
            listDate: item[ld] ? String(item[ld]) : undefined,
            assetType: "fut" as AssetType,
          }));
      })
    );
    return groups.flat();
  }

  // 外汇 (fx_obasic, 2000积分): FXCM's 40-odd pairs; classify is always "FX".
  private async fetchFxSymbols(): Promise<SymbolItem[]> {
    const response = await this.client.query("fx_obasic", {
      exchange: "FXCM",
      classify: "FX",
      fields: "ts_code,name",
    });
    if (!response.data?.items) return [];
    const [ts, nm] = ["ts_code", "name"].map((f) =>
      response.data!.fields.findIndex((x) => x.toLowerCase() === f)
    );
    return (response.data.items as any[]).map((item) => ({
      tsCode: String(item[ts] ?? ""),
      symbol: String(item[ts] ?? "").split(".")[0],
      name: String(item[nm] ?? ""),
      exchange: "FXCM",
      assetType: "fx" as AssetType,
    }));
  }

  // 申万行业指数 (index_classify src=SW2021, 2000积分): all three levels in one
  // call; only published indices (is_pub=1). Quotes come from sw_daily.
  private async fetchSwSymbols(): Promise<SymbolItem[]> {
    const response = await this.client.query("index_classify", {
      src: "SW2021",
      fields: "index_code,industry_name,level,is_pub",
    });
    if (!response.data?.items) return [];
    const [code, nm, lv, pub] = ["index_code", "industry_name", "level", "is_pub"].map((f) =>
      response.data!.fields.findIndex((x) => x.toLowerCase() === f)
    );
    return (response.data.items as any[])
      .filter((item) => String(item[pub]) === "1")
      .map((item) => ({
        tsCode: String(item[code] ?? ""),
        symbol: String(item[code] ?? "").split(".")[0],
        name: String(item[nm] ?? ""),
        exchange: String(item[lv] ?? ""), // L1/L2/L3 shown as the "exchange" badge
        assetType: "sw" as AssetType,
      }));
  }
}
