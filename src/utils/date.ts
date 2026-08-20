import type { Freq, RangePreset } from "../types";

const DATE_RANGE_RE = /^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/;

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseDateYmd(ymd: string): Date {
  return new Date(
    parseInt(ymd.slice(0, 4), 10),
    parseInt(ymd.slice(4, 6), 10) - 1,
    parseInt(ymd.slice(6, 8), 10)
  );
}

export function isDateRangeString(value: string): boolean {
  return DATE_RANGE_RE.test(value);
}

export function resolveDateRange(range: string): { start: string; end: string } {
  if (isDateRangeString(range)) {
    const [start, end] = range.split("~");
    return { start: start.replace(/-/g, ""), end: end.replace(/-/g, "") };
  }

  const today = new Date();
  const end = formatDate(today);
  let startDate: Date;

  switch (range as RangePreset) {
    case "ytd": {
      startDate = new Date(today.getFullYear(), 0, 1);
      break;
    }
    case "3y": {
      startDate = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
      break;
    }
    case "5y": {
      startDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
      break;
    }
    case "10y": {
      startDate = new Date(today.getFullYear() - 10, today.getMonth(), today.getDate());
      break;
    }
    case "20y": {
      startDate = new Date(today.getFullYear() - 20, today.getMonth(), today.getDate());
      break;
    }
    case "max": {
      startDate = new Date(1990, 0, 1);
      break;
    }
    case "1y":
    default: {
      startDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      break;
    }
  }

  return { start: formatDate(startDate), end };
}

export function getDefaultDateRange(): string {
  const today = new Date();
  const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  return `${formatIsoDate(start)}~${formatIsoDate(today)}`;
}

export function nextTradingDate(ymd: string): string {
  const date = parseDateYmd(ymd);
  date.setDate(date.getDate() + 1);
  return formatDate(date);
}

export function prevTradingDate(ymd: string): string {
  const date = parseDateYmd(ymd);
  date.setDate(date.getDate() - 1);
  return formatDate(date);
}

export function isDateInRange(ymd: string, start: string, end: string): boolean {
  return ymd >= start && ymd <= end;
}

export function getFreqName(freq: Freq): string {
  switch (freq) {
    case "W":
      return "weekly";
    case "M":
      return "monthly";
    case "D":
    default:
      return "daily";
  }
}

export function addDays(ymd: string, days: number): string {
  const date = parseDateYmd(ymd);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}
