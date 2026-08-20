// Arithmetic expressions for the 数据计算卡 (spread card): lettered series
// references (A/B/C…, assigned by series-list order), numeric literals, the
// four operators and parentheses — e.g. A+B, A/B, (A+B)/2, A+C/B.
// Pure module (no Obsidian imports): parsing, validation, evaluation and
// title formatting all live here so the edit modal and the series adapter
// share exactly one grammar.

export type ExprNode =
  | { kind: "num"; value: number }
  | { kind: "ref"; letter: string }
  | { kind: "neg"; operand: ExprNode }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: ExprNode; right: ExprNode };

export type ExprParseResult = { ok: true; ast: ExprNode } | { ok: false; error: string };

interface Token {
  kind: "num" | "ref" | "op" | "lparen" | "rparen";
  value: string; // raw text: number literal, uppercased letter, or normalized operator
}

// Full-width operator variants accepted alongside ASCII (wireframe copy uses
// − × /): ＋ − × ÷ ／ and full-width parens.
const OP_ALIASES: Record<string, string> = {
  "+": "+",
  "＋": "+",
  "-": "-",
  "−": "-",
  "*": "*",
  "×": "*",
  "/": "/",
  "／": "/",
  "÷": "/",
};

function tokenize(src: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(raw)) {
        return `无法识别的数字「${raw}」。`;
      }
      tokens.push({ kind: "num", value: raw });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      tokens.push({ kind: "ref", value: ch.toUpperCase() });
      i++;
      continue;
    }
    if (OP_ALIASES[ch] !== undefined) {
      tokens.push({ kind: "op", value: OP_ALIASES[ch] });
      i++;
      continue;
    }
    if (ch === "(" || ch === "（") {
      tokens.push({ kind: "lparen", value: "(" });
      i++;
      continue;
    }
    if (ch === ")" || ch === "）") {
      tokens.push({ kind: "rparen", value: ")" });
      i++;
      continue;
    }
    return `无法识别的字符「${ch}」。`;
  }
  return tokens;
}

/**
 * Parses and validates an expression against the series letters currently
 * defined (seriesCount 3 → A/B/C). Error messages are Chinese reasons without
 * a prefix; callers render them as `公式错误：${error}` (wireframe #screen-calc).
 */
export function parseExpression(src: string, seriesCount: number): ExprParseResult {
  const trimmed = src.trim();
  if (!trimmed) {
    return { ok: false, error: "请输入公式。" };
  }
  const tokens = tokenize(trimmed);
  if (typeof tokens === "string") {
    return { ok: false, error: tokens };
  }

  let pos = 0;
  const peek = (): Token | null => tokens[pos] ?? null;

  // expr := term ((+|-) term)*
  const parseExpr = (): ExprNode | string => {
    let left = parseTerm();
    if (typeof left === "string") return left;
    while (peek()?.kind === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      const op = peek()!.value as "+" | "-";
      pos++;
      const right = parseTerm();
      if (typeof right === "string") return right;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };

  // term := factor ((*|/) factor)*
  const parseTerm = (): ExprNode | string => {
    let left = parseFactor();
    if (typeof left === "string") return left;
    while (peek()?.kind === "op" && (peek()!.value === "*" || peek()!.value === "/")) {
      const op = peek()!.value as "*" | "/";
      pos++;
      const right = parseFactor();
      if (typeof right === "string") return right;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };

  // factor := num | ref | '(' expr ')' | ('-'|'+') factor
  const parseFactor = (): ExprNode | string => {
    const token = peek();
    if (!token) {
      return "公式不完整 — 末尾缺少系列代号或数字。";
    }
    if (token.kind === "op") {
      if (token.value === "-" || token.value === "+") {
        pos++;
        const operand = parseFactor();
        if (typeof operand === "string") return operand;
        return token.value === "-" ? { kind: "neg", operand } : operand;
      }
      return `「${displayOp(token.value)}」前面缺少系列代号或数字。`;
    }
    if (token.kind === "num") {
      pos++;
      return { kind: "num", value: Number(token.value) };
    }
    if (token.kind === "ref") {
      pos++;
      const index = token.value.charCodeAt(0) - 65; // "A" → 0
      if (index >= seriesCount) {
        const last = String.fromCharCode(65 + seriesCount - 1);
        return seriesCount > 0
          ? `系列代号「${token.value}」未定义（当前只有 A–${last}）。`
          : `系列代号「${token.value}」未定义（请先在下方新增系列）。`;
      }
      return { kind: "ref", letter: token.value };
    }
    if (token.kind === "lparen") {
      pos++;
      const inner = parseExpr();
      if (typeof inner === "string") return inner;
      if (peek()?.kind !== "rparen") {
        return "括号不匹配 —「(」缺少对应的「)」。";
      }
      pos++;
      return inner;
    }
    return "括号不匹配 — 多余的「)」。";
  };

  const ast = parseExpr();
  if (typeof ast === "string") {
    return { ok: false, error: ast };
  }
  const rest = peek();
  if (rest) {
    // A valid factor followed by more input, e.g. "A B" or "A)".
    return {
      ok: false,
      error: rest.kind === "rparen" ? "括号不匹配 — 多余的「)」。" : `「${tokenText(rest)}」位置不正确。`,
    };
  }
  return { ok: true, ast };
}

function tokenText(token: Token): string {
  return token.kind === "op" ? displayOp(token.value) : token.value;
}

// Display forms used in error messages and card titles (− × for readability).
export function displayOp(op: string): string {
  if (op === "-") return "−";
  if (op === "*") return "×";
  return op;
}

/** Pointwise evaluation; division by zero yields NaN (callers skip non-finite points). */
export function evalExpression(node: ExprNode, getValue: (letter: string) => number): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "ref":
      return getValue(node.letter);
    case "neg":
      return -evalExpression(node.operand, getValue);
    case "bin": {
      const left = evalExpression(node.left, getValue);
      const right = evalExpression(node.right, getValue);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
  }
}

/**
 * Card title: the expression with letters replaced by their series labels,
 * e.g. "A-B" → "茅台 − 沪深300". Assumes the expression already parses.
 */
export function formatExpressionTitle(expression: string, labels: string[]): string {
  const tokens = tokenize(expression);
  if (typeof tokens === "string") return expression;
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kind === "ref") {
      parts.push(labels[token.value.charCodeAt(0) - 65] ?? token.value);
    } else if (token.kind === "op") {
      parts.push(displayOp(token.value));
    } else {
      parts.push(token.value);
    }
  }
  // Space around operators, none around parens: "(茅台 + 沪深300) / 2".
  return parts
    .join(" ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
}
