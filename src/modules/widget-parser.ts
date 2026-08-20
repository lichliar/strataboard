export interface TradingViewWidgetParseResult {
  scriptUrl: string;
  config: Record<string, unknown>;
  fullHtml: string;
  title?: string;
}

export function parseTradingViewHtml(html: string): TradingViewWidgetParseResult | null {
  const trimmed = html.trim();

  // Match the TradingView external-embedding script tag and its JSON body.
  const scriptMatch = trimmed.match(
    /<script[^>]*src="([^"]*tradingview\.com\/external-embedding\/[^"]*)"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!scriptMatch) return null;

  const scriptUrl = scriptMatch[1];
  const configText = scriptMatch[2].trim();

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configText);
  } catch {
    return null;
  }

  const fullHtml = buildTradingViewWidgetHtml(scriptUrl, config);
  const title = extractTitle(config);

  return { scriptUrl, config, fullHtml, title };
}

function extractTitle(config: Record<string, unknown>): string | undefined {
  const symbols = config.symbols;
  if (Array.isArray(symbols) && symbols.length > 0) {
    const first = symbols[0];
    if (Array.isArray(first) && typeof first[0] === "string") {
      return first[0];
    }
    if (typeof first === "string") {
      return first;
    }
  }
  if (typeof config.symbol === "string") return config.symbol;
  return undefined;
}

export function buildTradingViewWidgetHtml(
  scriptUrl: string,
  config: Record<string, unknown>
): string {
  const bg = typeof config.backgroundColor === "string" ? config.backgroundColor : "#ffffff";
  const configJson = JSON.stringify(config, null, 2);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${bg}; }
    .tradingview-widget-container { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <div class="tradingview-widget-copyright">
      <a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">
        <span class="blue-text">Charts by TradingView</span>
      </a>
    </div>
    <script type="text/javascript" src="${scriptUrl}" async>
${configJson}
    </script>
  </div>
</body>
</html>`;
}

export interface WidgetInputParseResult {
  widgetType: "iframe" | "html";
  iframeUrl?: string;
  widgetHtml?: string;
  title?: string;
}

// ==================== Widget code analysis (insert modal, phase 4) ====================

// Recognized embed formats (wireframe #screen-widget):
//  - "tvjs":       tv.js + new TradingView.widget({...}) — a JS object literal
//  - "embed":      external-embedding embed-widget-*.js script with inline JSON
//  - "iframe-url": a bare tradingview.com URL — params live in the query
//  - "raw":        anything else (any HTML / non-TradingView URL) — manual only
export type WidgetCodeKind = "tvjs" | "embed" | "iframe-url" | "raw";

export interface WidgetCodeParse {
  kind: WidgetCodeKind;
  /** Extracted config; null for raw input (nothing machine-editable). */
  config: Record<string, unknown> | null;
  /** Display name for the detected pill, e.g. "高级图表组件". */
  widgetName?: string;
  /** Auto title from the config's symbol field. */
  title?: string;
  /** Rewrites the ORIGINAL input with a modified config (two-way sync). */
  withConfig(next: Record<string, unknown>): string;
}

// embed-widget script filename → Chinese component name (detected pill).
const EMBED_WIDGET_NAMES: { match: string; name: string }[] = [
  { match: "advanced-chart", name: "高级图表组件" },
  { match: "mini-symbol-overview", name: "迷你走势组件" },
  { match: "mini-chart", name: "迷你走势组件" },
  { match: "market-overview", name: "市场概览组件" },
  { match: "market-quotes", name: "市场报价组件" },
  { match: "screener", name: "股票筛选器组件" },
  { match: "symbol-overview", name: "标的概览组件" },
  { match: "symbol-info", name: "标的信息组件" },
  { match: "ticker-tape", name: "行情滚动条组件" },
  { match: "economic-calendar", name: "财经日历组件" },
];

function embedWidgetName(scriptUrl: string): string {
  for (const entry of EMBED_WIDGET_NAMES) {
    if (scriptUrl.includes(entry.match)) return entry.name;
  }
  return "TradingView 组件";
}

/** Parses the pasted widget code for the insert modal; null only when empty. */
export function parseWidgetCode(input: string): WidgetCodeParse | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Bare URL: TradingView widgetembed → params from the query string;
  // any other URL stays "raw" (the insert path iframes it as-is).
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.includes("tradingview.com")) {
        const config: Record<string, unknown> = {};
        url.searchParams.forEach((value, key) => {
          config[key] = value === "true" ? true : value === "false" ? false : value;
        });
        return {
          kind: "iframe-url",
          config,
          widgetName: "iframe 嵌入",
          title: typeof config.symbol === "string" ? config.symbol : undefined,
          withConfig(next) {
            const out = new URL(trimmed);
            Array.from(out.searchParams.keys()).forEach((key) => out.searchParams.delete(key));
            for (const [key, value] of Object.entries(next)) {
              if (value === undefined || value === null) continue;
              out.searchParams.set(key, String(value));
            }
            return out.toString();
          },
        };
      }
    } catch {
      // fall through to raw
    }
    return { kind: "raw", config: null, withConfig: () => input };
  }

  // embed-widget-*.js script with an inline JSON body.
  const scriptMatch = trimmed.match(
    /<script[^>]*src="([^"]*tradingview\.com\/external-embedding\/[^"]*)"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (scriptMatch && scriptMatch.index !== undefined) {
    const scriptUrl = scriptMatch[1];
    const full = scriptMatch[0];
    const bodyStartInFull = full.indexOf(">") + 1;
    const bodyEndInFull = full.length - "</script>".length;
    try {
      const config = JSON.parse(scriptMatch[2].trim()) as Record<string, unknown>;
      const start = scriptMatch.index + bodyStartInFull;
      const end = scriptMatch.index + bodyEndInFull;
      return {
        kind: "embed",
        config,
        widgetName: embedWidgetName(scriptUrl),
        title: extractTitle(config),
        withConfig(next) {
          return `${trimmed.slice(0, start)}\n${JSON.stringify(next, null, 2)}\n  ${trimmed.slice(end)}`;
        },
      };
    } catch {
      return { kind: "raw", config: null, withConfig: () => input };
    }
  }

  // tv.js + new TradingView.widget({...}) with a JS object literal.
  const widgetCall = trimmed.search(/new\s+TradingView\.widget\s*\(/);
  if (widgetCall >= 0) {
    const objStart = trimmed.indexOf("{", widgetCall);
    if (objStart >= 0) {
      const objEnd = findMatchingBrace(trimmed, objStart);
      if (objEnd > objStart) {
        const config = parseJsObjectLiteral(trimmed.slice(objStart, objEnd + 1));
        if (config) {
          return {
            kind: "tvjs",
            config,
            widgetName: "高级图表组件",
            title: extractTitle(config),
            withConfig(next) {
              return trimmed.slice(0, objStart) + JSON.stringify(next, null, 2) + trimmed.slice(objEnd + 1);
            },
          };
        }
      }
    }
  }

  return { kind: "raw", config: null, withConfig: () => input };
}

// Index of the "}" matching the "{" at start, skipping over string literals.
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Tolerant JS-object-literal parse: strict JSON first, then quote keys /
// single quotes / strip trailing commas.
function parseJsObjectLiteral(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // continue
  }
  try {
    const sanitized = text
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseWidgetInput(input: string, fallbackTitle?: string): WidgetInputParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Plain URL.
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      widgetType: "iframe",
      iframeUrl: trimmed,
      title: fallbackTitle || extractUrlTitle(trimmed),
    };
  }

  // TradingView snippet.
  const tv = parseTradingViewHtml(trimmed);
  if (tv) {
    return {
      widgetType: "html",
      widgetHtml: tv.fullHtml,
      title: tv.title ?? fallbackTitle,
    };
  }

  // Fallback: treat the whole input as raw HTML and wrap it minimally.
  return {
    widgetType: "html",
    widgetHtml: wrapRawHtml(trimmed),
    title: fallbackTitle,
  };
}

function extractUrlTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "Widget";
  }
}

function wrapRawHtml(html: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}
