import { monaco } from './monacoSetup'

export type ThemeName = 'light' | 'dark'

const KEY = 'meencode-theme'

export function getTheme(): ThemeName {
  return (document.documentElement.dataset.theme as ThemeName) || 'light'
}

export function setTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(KEY, theme)
  monaco.editor.setTheme(theme === 'light' ? 'meencode-light' : 'meencode-dark')
  document.dispatchEvent(new CustomEvent('meencode:theme-changed', { detail: theme }))
}

export function initTheme(): void {
  const saved = (localStorage.getItem(KEY) as ThemeName | null) ?? 'light'
  document.documentElement.dataset.theme = saved
  monaco.editor.setTheme(saved === 'light' ? 'meencode-light' : 'meencode-dark')
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'light' ? 'dark' : 'light')
}

export function xtermTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  if (getTheme() === 'light') {
    return { background: '#ffffff', foreground: '#1f2430', cursor: '#4f8cff', selectionBackground: '#b3d1ff' }
  }
  return { background: '#0b0d12', foreground: '#d7dce5', cursor: '#4f8cff', selectionBackground: '#2a3f5f' }
}