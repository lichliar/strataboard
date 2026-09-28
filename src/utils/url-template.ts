// Pure URL templating helpers for the custom-source setup wizard: the user
// pastes a full working URL and these turn it into a {placeholder} template.
// No obsidian imports, so they can be exercised from node.

// Query-param names commonly carrying the search keyword; used to turn a
// pasted full search URL into a {query} template.
const SEARCH_QUERY_PARAMS = ["q", "query", "keyword", "keywords", "wd", "word", "input", "search", "key"];

// Query-param names commonly carrying an API key/credential (compared
// lowercased); their values become {apiKey} placeholders in the template and
// are offered for auto-filling the key field.
const API_KEY_PARAMS = ["apikey", "api_key", "key", "token", "access_key", "api_token", "apitoken", "appkey", "app_key"];

// Turns a full working URL into a template: the sample code becomes {code},
// the first/last ISO dates become {startIso}/{endIso}, the first/last
// YYYYMMDD dates become {start}/{end}, and a well-known credential param
// becomes {apiKey}. URLs that are already templates pass through untouched.
export function autoTemplateUrl(url: string, sampleCode: string): string {
  let out = url.trim();
  out = out.replace(/([?&])([\w.-]+)=([^&]*)/g, (match, sep: string, key: string, value: string) =>
    value && API_KEY_PARAMS.includes(key.toLowerCase()) ? `${sep}${key}={apiKey}` : match,
  );
  const code = sampleCode.trim();
  if (code) {
    out = out.split(code).join("{code}");
    const encoded = encodeURIComponent(code);
    if (encoded !== code) out = out.split(encoded).join("{code}");
  }
  out = replaceDateTokens(out, /\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/g, "{startIso}", "{endIso}");
  out = replaceDateTokens(out, /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g, "{start}", "{end}");
  return out;
}

// Replaces the first date match with startToken and the last with endToken
// (a single match becomes endToken; middle matches stay literal).
function replaceDateTokens(url: string, pattern: RegExp, startToken: string, endToken: string): string {
  const matches = [...url.matchAll(pattern)];
  if (matches.length === 0) return url;
  const replacements = new Map<number, string>();
  if (matches.length === 1) {
    replacements.set(matches[0].index!, endToken);
  } else {
    replacements.set(matches[0].index!, startToken);
    replacements.set(matches[matches.length - 1].index!, endToken);
  }
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    const index = match.index!;
    const replacement = replacements.get(index);
    if (replacement === undefined) continue;
    out += url.slice(cursor, index) + replacement;
    cursor = index + match[0].length;
  }
  return out + url.slice(cursor);
}

// Returns the (decoded) API key carried by a full URL's well-known
// credential param, or null when none is present. Used to auto-fill the key
// field in the setup wizard from the pasted URL.
export function extractApiKey(url: string): string | null {
  for (const match of url.matchAll(/[?&]([\w.-]+)=([^&]*)/g)) {
    if (match[2] && API_KEY_PARAMS.includes(match[1].toLowerCase())) {
      try {
        return decodeURIComponent(match[2]);
      } catch {
        return match[2];
      }
    }
  }
  return null;
}

// Turns a full search URL into a {query} template by rewriting the value of
// the first well-known keyword param. Returns the input unchanged when no
// known param is present (the UI hints the user to edit it manually). Works
// on the raw string rather than URL.toString(), which would percent-encode
// the braces.
export function autoTemplateSearchUrl(url: string): string {
  const trimmed = url.trim();
  let replaced = false;
  return trimmed.replace(/([?&])([\w.-]+)=([^&]*)/g, (match, sep: string, key: string) => {
    if (!replaced && SEARCH_QUERY_PARAMS.includes(key.toLowerCase())) {
      replaced = true;
      return `${sep}${key}={query}`;
    }
    return match;
  });
}
