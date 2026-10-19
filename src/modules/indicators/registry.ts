/**
 * Indicator registry: user-provided custom indicators come and go with every
 * indicator-folder sync (loader.ts calls clear + register).
 */

import type { IndicatorDef } from "./contract";

export class IndicatorRegistry {
  private indicators = new Map<string, IndicatorDef>();

  registerCustom(def: IndicatorDef): { ok: boolean; error?: string } {
    if (this.indicators.has(def.id)) {
      return { ok: false, error: `指标 id "${def.id}" 与另一个自定义指标重名` };
    }
    this.indicators.set(def.id, def);
    return { ok: true };
  }

  clearCustom(): void {
    this.indicators.clear();
  }

  resolve(id: string): IndicatorDef | undefined {
    return this.indicators.get(id);
  }

  list(): IndicatorDef[] {
    return [...this.indicators.values()];
  }

  listByCategory(): Map<string, IndicatorDef[]> {
    const groups = new Map<string, IndicatorDef[]>();
    for (const def of this.list()) {
      const group = groups.get(def.category);
      if (group) {
        group.push(def);
      } else {
        groups.set(def.category, [def]);
      }
    }
    return groups;
  }
}

export const indicatorRegistry = new IndicatorRegistry();
