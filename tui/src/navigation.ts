import type { Route } from './pages.js';

interface Frame { route: Route; row: number; scroll: number; focus: 'list' | 'detail'; search: string; selected?: string }
export interface Navigation extends Frame { stack: Frame[]; marked: string[]; refresh: number; notice?: string }
export type Action = { type: 'open'; route: Route; replace?: boolean } | { type: 'resolved'; route: Route; selected?: string }
  | { type: 'back' } | { type: 'row'; row: number; selected?: string } | { type: 'scroll'; scroll: number }
  | { type: 'focus'; focus?: 'list' | 'detail' } | { type: 'search'; search: string } | { type: 'mark'; id: string } | { type: 'refresh' };
const fresh = (route: Route): Frame => ({ route, row: 0, scroll: 0, focus: 'list', search: '' });
export const initial: Navigation = { ...fresh({ kind: 'home' }), stack: [], marked: [], refresh: 0 };
export function navigate(state: Navigation, action: Action): Navigation {
  switch (action.type) {
    case 'open': {
      if (!action.replace && state.stack.length >= 32) return { ...state, notice: '返回栈已达 32 层，请先返回' };
      const { stack, marked, refresh, notice, ...frame } = state;
      return { ...fresh(action.route), stack: action.replace ? stack : [...stack, frame], marked: [], refresh };
    }
    case 'resolved': return { ...state, route: action.route, selected: state.selected ?? action.selected };
    case 'back': { const prev = state.stack.at(-1); return prev ? { ...state, ...prev, stack: state.stack.slice(0, -1), marked: [], notice: undefined } : state; }
    case 'row': return { ...state, row: action.row, selected: action.selected, scroll: 0 };
    case 'scroll': return { ...state, scroll: Math.max(0, action.scroll) };
    case 'focus': return { ...state, focus: action.focus ?? (state.focus === 'list' ? 'detail' : 'list') };
    case 'search': return { ...state, search: action.search, selected: undefined, row: 0, scroll: 0 };
    case 'mark': return { ...state, marked: state.marked.includes(action.id) ? state.marked.filter(x => x !== action.id) : state.marked.length < 2 ? [...state.marked, action.id] : state.marked };
    case 'refresh': return { ...state, refresh: state.refresh + 1, marked: [] };
  }
}
export interface ReadingPosition { line: number; total: number; width: number; digest: string }
export interface TreePosition { selected?: string; expanded: Record<string, boolean>; readings: Record<string, ReadingPosition> }
export class Positions {
  private entries = new Map<string, TreePosition>();
  get(key: string) {
    let state = this.entries.get(key); if (!state) state = { expanded: {}, readings: {} };
    this.entries.delete(key); this.entries.set(key, state);
    if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
    return state;
  }
  trim(state: TreePosition) {
    const keys = [...new Set([...Object.keys(state.expanded), ...Object.keys(state.readings)])];
    for (const key of keys.filter(k => k !== state.selected).slice(0, Math.max(0, keys.length - 1000))) { delete state.expanded[key]; delete state.readings[key]; }
  }
  clear(key: string) { this.entries.delete(key); }
}
