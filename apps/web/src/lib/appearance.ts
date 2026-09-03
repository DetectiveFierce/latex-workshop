import { useCallback, useEffect, useState } from 'react';

export type AppearancePreferences = {
  editorFontSize: number;
  uiScale: number;
};

const STORAGE_KEY = 'appearance';
const CHANGE_EVENT = 'appearance-change';
const defaults: AppearancePreferences = { editorFontSize: 13, uiScale: 1 };

export function readAppearance(): AppearancePreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    const value = typeof raw === 'object' && raw !== null ? raw : null;
    const editorFontSize = value && 'editorFontSize' in value ? value.editorFontSize : undefined;
    const uiScale = value && 'uiScale' in value ? value.uiScale : undefined;
    return {
      editorFontSize: clampNumber(editorFontSize, defaults.editorFontSize, 11, 22),
      uiScale: clampNumber(uiScale, defaults.uiScale, 0.9, 1.2),
    };
  } catch {
    return defaults;
  }
}

export function applyAppearance(preferences = readAppearance()) {
  document.documentElement.style.setProperty('--ui-font-scale', String(preferences.uiScale));
}

export function useAppearance() {
  const [preferences, setPreferences] = useState(readAppearance);

  useEffect(() => {
    const sync = () => setPreferences(readAppearance());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((next: Partial<AppearancePreferences>) => {
    const current = readAppearance();
    const value = {
      editorFontSize: clampNumber(next.editorFontSize, current.editorFontSize, 11, 22),
      uiScale: clampNumber(next.uiScale, current.uiScale, 0.9, 1.2),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    applyAppearance(value);
    setPreferences(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { preferences, update };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  return Math.min(
    max,
    Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback),
  );
}
