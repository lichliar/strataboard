import { SuggestModal, type App } from "obsidian";
import type { FredSeriesInfo } from "../types";

export type SearchFredSeries = (text: string) => Promise<FredSeriesInfo[]>;

// Shown when the query is empty: a curated list of the most-watched FRED
// series so the modal is useful before the user types anything.
const POPULAR_SERIES: FredSeriesInfo[] = [
  { id: "DGS10", title: "10-Year Treasury Constant Maturity Rate", frequency: "Daily", units: "Percent", popularity: 0 },
  { id: "DGS2", title: "2-Year Treasury Constant Maturity Rate", frequency: "Daily", units: "Percent", popularity: 0 },
  { id: "T10Y2Y", title: "10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity", frequency: "Daily", units: "Percent", popularity: 0 },
  { id: "FEDFUNDS", title: "Federal Funds Effective Rate", frequency: "Monthly", units: "Percent", popularity: 0 },
  { id: "CPIAUCSL", title: "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average", frequency: "Monthly", units: "Index 1982-1984=100", popularity: 0 },
  { id: "UNRATE", title: "Unemployment Rate", frequency: "Monthly", units: "Percent", popularity: 0 },
  { id: "PAYEMS", title: "All Employees, Total Nonfarm", frequency: "Monthly", units: "Thousands of Persons", popularity: 0 },
  { id: "GDP", title: "Gross Domestic Product", frequency: "Quarterly", units: "Billions of Dollars", popularity: 0 },
  { id: "GDPC1", title: "Real Gross Domestic Product", frequency: "Quarterly", units: "Billions of Chained 2017 Dollars", popularity: 0 },
  { id: "M2SL", title: "M2", frequency: "Monthly", units: "Billions of Dollars", popularity: 0 },
  { id: "SP500", title: "S&P 500", frequency: "Daily", units: "Index", popularity: 0 },
  { id: "DCOILWTICO", title: "Crude Oil Prices: West Texas Intermediate (WTI) - Cushing, Oklahoma", frequency: "Daily", units: "Dollars per Barrel", popularity: 0 },
  { id: "DEXCHUS", title: "Chinese Yuan Renminbi to U.S. Dollar Spot Exchange Rate", frequency: "Daily", units: "Chinese Yuan to One U.S. Dollar", popularity: 0 },
  { id: "MORTGAGE30US", title: "30-Year Fixed Rate Mortgage Average in the United States", frequency: "Weekly", units: "Percent", popularity: 0 },
];

/**
 * FRED series picker backed by the remote /fred/series/search API (the
 * symbol search modal is local-only, so this is a separate SuggestModal).
 * Keystrokes are debounced; a sequence counter keeps stale responses from
 * overwriting newer results. Shared by the standalone-card insertion flow
 * and the FRED row in the overlay/spread editors.
 */
export class FredSearchModal extends SuggestModal<FredSeriesInfo> {
  private search: SearchFredSeries;
  private onSelectCallback: (info: FredSeriesInfo) => void;
  private callSeq = 0;

  constructor(app: App, search: SearchFredSeries, onSelect: (info: FredSeriesInfo) => void) {
    super(app);
    this.search = search;
    this.onSelectCallback = onSelect;
    this.setPlaceholder("输入英文关键词搜索 FRED 系列（如 cpi、treasury、oil）…");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "确认" },
      { command: "esc", purpose: "关闭" },
    ]);
  }

  async getSuggestions(query: string): Promise<FredSeriesInfo[]> {
    const text = query.trim();
    if (!text) {
      return POPULAR_SERIES;
    }

    const seq = ++this.callSeq;
    await sleep(300);
    if (seq !== this.callSeq) {
      // A newer keystroke owns the suggestion list now.
      return [];
    }

    try {
      return await this.search(text);
    } catch (e) {
      console.error("FredSearchModal: search failed", e);
      return [];
    }
  }

  renderSuggestion(info: FredSeriesInfo, el: HTMLElement): void {
    el.createSpan({ text: info.title });
    const meta = [info.id, info.frequency, info.units].filter(Boolean).join(" · ");
    el.createSpan({ cls: "fc-symbol-meta", text: meta });
  }

  onChooseSuggestion(info: FredSeriesInfo, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback(info);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
