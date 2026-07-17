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
