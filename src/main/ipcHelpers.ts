import { getSettings } from './settingsStore'

export function requireRoot(): string {
  const root = getSettings().workspace
  if (!root) throw new Error('No workspace open')
  return root
}