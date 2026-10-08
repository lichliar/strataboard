/**
 * Indicator registry: builtins are fixed at module load, customs come and go
 * with every indicator-folder sync (loader.ts calls clearCustom + registerCustom).
 */

import { BUILTIN_INDICATORS } from "./builtins";
import type { IndicatorDef } from "./contract";

export class IndicatorRegistry {
  private builtins = new Map<string, IndicatorDef>();
  private customs = new Map<string, IndicatorDef>();

  registerBuiltin(def: IndicatorDef): void {
    if (this.builtins.has(def.id)) {
      throw new Error(`[StrataBoard] duplicate builtin indicator id "${def.id}"`);
    }
    this.builtins.set(def.id, def);
  }

  registerCustom(def: IndicatorDef): { ok: boolean; error?: string } {
    if (this.builtins.has(def.id)) {
      return { ok: false, error: `指标 id "${def.id}" 与内置指标冲突` };
    }
    if (this.customs.has(def.id)) {
      return { ok: false, error: `指标 id "${def.id}" 与另一个自定义指标重名` };
    }
    this.customs.set(def.id, def);
    return { ok: true };
  }

  clearCustom(): void {
    this.customs.clear();
  }

  resolve(id: string): IndicatorDef | undefined {
    return this.builtins.get(id) ?? this.customs.get(id);
  }

  /** Builtins first, then customs. */
  list(): IndicatorDef[] {
    return [...this.builtins.values(), ...this.customs.values()];
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
for (const def of BUILTIN_INDICATORS) {
  indicatorRegistry.registerBuiltin(def);
}
