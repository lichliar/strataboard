import type { AssetType, SymbolItem } from "../types";
import { SqliteCache } from "./sqlite-cache";
import { TushareApiClient } from "./tushare-api-client";

interface SymbolIndexOptions {
  cache: SqliteCache;
  token: string;
  refreshIntervalDays: number;
}

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

    const fresh = await this.fetchAssetType(assetType);
    await this.cache.saveSymbols(assetType, fresh);
    return fresh;
  }

  async lookup(tsCode: string, assetType: AssetType): Promise<SymbolItem | undefined> {
    const cached = await this.cache.lookupSymbol(tsCode, assetType);
    if (cached) return cached;

    // Fall back to refreshing the list if the symbol is missing.
    await this.loadAssetType(assetType);
    return this.cache.lookupSymbol(tsCode, assetType);
  }

  private async fetchAssetType(assetType: AssetType): Promise<SymbolItem[]> {
    let apiName = "";
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
    }

    const response = await this.client.query(apiName, {
      exchange: "",
      list_status: "L",
      fields: "ts_code,symbol,name,enname,fullname,exchange,list_date",
    });

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
    const exchangeIdx = getIndex("exchange");
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
}
