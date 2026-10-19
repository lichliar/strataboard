export interface TradingViewWidgetParseResult {
  scriptUrl: string;
  config: Record<string, unknown>;
  fullHtml: string;
  title?: string;
}

const TRADINGVIEW_ROOT_HOST = "tradingview.com";
const TRADINGVIEW_LEGACY_SCRIPT = "https://s3.tradingview.com/tv.js";

export function isTradingViewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      (hostname === TRADINGVIEW_ROOT_HOST || hostname.endsWith(`.${TRADINGVIEW_ROOT_HOST}`))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scriptTags(html: string): { src: string; body: string }[] {
  const tags: { src: string; body: string }[] = [];
  const pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    tags.push({ src: match[2], body: match[3] });
  }
  return tags;
}

export function parseTradingViewHtml(html: string): TradingViewWidgetParseResult | null {
  const trimmed = html.trim();

  // Only accept the official HTTPS external-embedding script. Rebuilding the
  // document below intentionally discards every other pasted tag/script.
  const script = scriptTags(trimmed).find(({ src }) => {
    if (!isTradingViewUrl(src)) return false;
    try {
      return new URL(src).pathname.startsWith("/external-embedding/");
    } catch {
      return false;
    }
  });
  if (!script) return null;

  const scriptUrl = new URL(script.src).toString();
  const configText = script.body.trim();

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(configText) as unknown;
    if (!isRecord(parsed)) return null;
    config = parsed;
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
  if (!isTradingViewUrl(scriptUrl)) {
    throw new Error("TradingView widget script URL is not allowed.");
  }
  const requestedBg = typeof config.backgroundColor === "string" ? config.backgroundColor : "";
  const bg = /^#[0-9a-f]{3,8}$/i.test(requestedBg) ? requestedBg : "#ffffff";
  const configJson = safeInlineJson(config);

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

function buildLegacyTradingViewWidgetHtml(config: Record<string, unknown>): string {
  const normalized = { ...config, container_id: "tradingview_widget" };
  const configJson = safeInlineJson(normalized);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    #tradingview_widget { flex: 1 1 auto; min-height: 0; width: 100%; }
    .tradingview-widget-copyright { flex: 0 0 auto; font-size: 13px; }
  </style>
</head>
<body>
  <div id="tradingview_widget"></div>
  <div class="tradingview-widget-copyright">
    <a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">Charts by TradingView</a>
  </div>
  <script src="${TRADINGVIEW_LEGACY_SCRIPT}"></script>
  <script>new TradingView.widget(${configJson});</script>
</body>
</html>`;
}

function safeInlineJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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
//  - "invalid":    anything outside the TradingView allowlist
export type WidgetCodeKind = "tvjs" | "embed" | "iframe-url" | "invalid";

export interface WidgetCodeParse {
  kind: WidgetCodeKind;
  /** Extracted config; null for invalid input. */
  config: Record<string, unknown> | null;
  /** Display name for the detected pill, e.g. "高级图表组件". */
  widgetName?: string;
  /** Auto title from the config's symbol field. */
  title?: string;
  /** Rebuilds allowlisted widget content with a modified config. */
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

  // Bare URL: only official TradingView HTTPS URLs are accepted.
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (isTradingViewUrl(trimmed)) {
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
      // fall through to invalid
    }
    return { kind: "invalid", config: null, withConfig: () => input };
  }

  // Official external-embedding snippet. Always rewrite to the canonical,
  // stripped document so unrelated pasted HTML never survives insertion.
  const embedded = parseTradingViewHtml(trimmed);
  if (embedded) {
    return {
      kind: "embed",
      config: embedded.config,
      widgetName: embedWidgetName(embedded.scriptUrl),
      title: extractTitle(embedded.config),
      withConfig(next) {
        return buildTradingViewWidgetHtml(embedded.scriptUrl, next);
      },
    };
  }

  // Legacy tv.js + new TradingView.widget({...}). Require the official script
  // and rebuild a minimal document instead of retaining arbitrary markup.
  const hasOfficialLegacyScript = scriptTags(trimmed).some(({ src }) => {
    if (!isTradingViewUrl(src)) return false;
    try {
      return new URL(src).pathname === "/tv.js";
    } catch {
      return false;
    }
  });
  const widgetCall = trimmed.search(/new\s+TradingView\.widget\s*\(/);
  if (hasOfficialLegacyScript && widgetCall >= 0) {
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
              return buildLegacyTradingViewWidgetHtml(next);
            },
          };
        }
      }
    }
  }

  return { kind: "invalid", config: null, withConfig: () => input };
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
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    // continue
  }
  try {
    const sanitized = text
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/,\s*([}\]])/g, "$1");
    const parsed = JSON.parse(sanitized) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseWidgetInput(input: string, fallbackTitle?: string): WidgetInputParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Plain official TradingView URL.
  if (isTradingViewUrl(trimmed)) {
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

  const parsed = parseWidgetCode(trimmed);
  if (parsed?.kind === "tvjs" && parsed.config) {
    return {
      widgetType: "html",
      widgetHtml: buildLegacyTradingViewWidgetHtml(parsed.config),
      title: parsed.title ?? fallbackTitle,
    };
  }

  return null;
}

function extractUrlTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "Widget";
  }
}
