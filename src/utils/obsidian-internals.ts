// Minimal structural types for undocumented Obsidian internals, verified
// against app.asar behavior. The public obsidian.d.ts omits the canvas
// object model, menu submenus, the settings window, and core plugin
// instances; these interfaces cover exactly the members this plugin uses.

import { App, ItemView, Menu, MenuItem, TFile } from "obsidian";

export interface CanvasNodeLike {
  filePath?: string;
  nodeEl?: HTMLElement;
  el?: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  remove?: () => void;
  resize?: (size: { width: number; height: number }) => void;
}

export interface CanvasLike {
  nodes: Map<unknown, CanvasNodeLike>;
  removeNode?: (node: CanvasNodeLike) => void;
  requestSave?: () => void;
  createFileNode?: (options: {
    file: TFile;
    pos: { x: number; y: number };
    size: { width: number; height: number };
  }) => CanvasNodeLike | undefined;
  posCenter?: () => { x: number; y: number };
  getViewportCenter?: () => { x: number; y: number };
}

export type CanvasViewLike = { canvas?: CanvasLike; containerEl: HTMLElement } & ItemView;

// The active view cast to its canvas shape; returns null when no ItemView
// is active (caller checks .canvas to confirm it really is a canvas view).
export function getCanvasView(app: App): CanvasViewLike | null {
  return app.workspace.getActiveViewOfType(ItemView) as CanvasViewLike | null;
}

// setSubmenu() is internal (absent from obsidian.d.ts) but is how Obsidian
// itself nests menus (e.g. table row/column).
export type MenuItemWithSubmenu = MenuItem & { setSubmenu(): Menu };

export type AppWithSetting = App & {
  setting: { open(): void; openTabById(id: string): void };
};

// app.setting is not in the public d.ts but is the standard way plugins
// open the settings window.
export function openPluginSettings(app: App, tabId: string): void {
  const setting = (app as AppWithSetting).setting;
  setting.open();
  setting.openTabById(tabId);
}

// Core plugin instances (e.g. "daily-notes") hang off app.internalPlugins.
export interface AppWithInternalPlugins {
  internalPlugins?: {
    plugins?: Record<string, { instance?: { options?: { folder?: unknown; format?: unknown } } }>;
  };
}
