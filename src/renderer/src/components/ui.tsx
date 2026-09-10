type IconName =
  | 'folder' | 'folderOpen' | 'file' | 'chat' | 'terminal' | 'settings' | 'play' | 'stop' | 'check'
  | 'x' | 'revert' | 'sparkle' | 'chevronDown' | 'chevronRight' | 'chevronLeft' | 'plus' | 'plusFolder' | 'refresh'
  | 'search' | 'attach' | 'send' | 'min' | 'max' | 'close' | 'eye' | 'eyeOff' | 'alert' | 'review'
    | 'external' | 'spinner' | 'dot' | 'git' | 'import' | 'browser' | 'dots' | 'edit'

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const p: Record<IconName, React.ReactNode> = {
    folder: <path d="M1.75 3.5a.75.75 0 0 1 .75-.75h3.55l1.6 1.5h4.6a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75v-9Z" />,
    folderOpen: <path d="M1.75 3.5a.75.75 0 0 1 .75-.75h3.55l1.6 1.5h4.35v1.25H8.02L4.7 11.75H2.5a.75.75 0 0 1-.75-.75v-7.5Zm2.7 8.25 2.83-5.5h5.97a.75.75 0 0 1 .66 1.11l-2.8 4.39H4.45Z" />,
    file: <path d="M4 1.75A.25.25 0 0 1 4.25 1.5h4.4l3.1 3.1v8.65a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25V1.75Zm4.4-.35 3.45 3.45H8.75a.35.35 0 0 1-.35-.35V1.4Z" />,
    chat: <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H6.25L3 14v-3H3.5A1.5 1.5 0 0 1 2 9.5v-7Z" />,
    terminal: <path d="M1.75 2.5A1.75 1.75 0 0 1 3.5.75h9a1.75 1.75 0 0 1 1.75 1.75v10.5A1.75 1.75 0 0 1 12.5 14h-9A1.75 1.75 0 0 1 1.75 12.25V2.5Zm2.6 2.35 2.1 2.1-2.1 2.1.95.95 3.05-3.05-3.05-3.05-.95.95Zm4.4 4.4v1.2h4v-1.2h-4Z" />,
    settings: <path d="M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Zm0 1.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm-1.5-4.5L6 .9 4.2 1.4l-.2 1.4-1.3.6-1.2-.8L.3 4.4l.9 1.1-.3 1.4-1.3.5v1.9l1.3.5.3 1.4-.9 1.1 1.2 1.8 1.2-.8 1.3.6.2 1.4H8l.2-1.4 1.3-.6 1.2.8 1.2-1.8-.9-1.1.3-1.4 1.3-.5V7.4l-1.3-.5-.3-1.4.9-1.1L10.1 2.2l-1.2.8-1.3-.6-.2-1.4H6.5Z" transform="translate(1.5 0.6) scale(0.86)" />,
    play: <path d="M4 2.5v11l9-5.5-9-5.5Z" />,
    stop: <rect x="3" y="3" width="10" height="10" rx="1.5" />,
    check: <path d="M2.5 8.5 6 12l7.5-8.5L12 2.5 6 8.7 4 6.7 2.5 8.5Z" />,
    x: <path d="M3 3l10 10M13 3L3 13" strokeWidth="1.6" fill="none" />,
    revert: <path d="M7.5 2.5 3 7l4.5 4.5v-3c3 0 5 1.5 5.5 4.5.5-4-1.5-7-5.5-7.5v-3Z" />,
    edit: <path d="M11.5 1.8 14 4.3 5.3 13H2.5v-2.8L11.5 1.8Zm-1 2.1-.9.9 1.5 1.5.9-.9-1.5-1.5Z" />,
    sparkle: <path d="M8 1l1.7 4.6L14 7.3l-4.3 1.7L8 13.6 6.3 9 2 7.3l4.3-1.7L8 1Zm5.5 8.8.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7.7-1.9Z" />,
    chevronDown: <path d="M3.5 6l4.5 4.5L12.5 6" strokeWidth="1.5" fill="none" />,
    chevronRight: <path d="M6 3.5L10.5 8 6 12.5" strokeWidth="1.5" fill="none" />,
    chevronLeft: <path d="M10 3.5L5.5 8 10 12.5" strokeWidth="1.5" fill="none" />,
    plus: <path d="M8 3v10M3 8h10" strokeWidth="1.5" fill="none" />,
    plusFolder: <path d="M1.75 3.5a.75.75 0 0 1 .75-.75h3.55l1.6 1.5h4.6a.75.75 0 0 1 .75.75v2.25H11V6.25H4.15L2.5 4.75v6.5h5.5v1.5H2.5a.75.75 0 0 1-.75-.75v-7.5ZM11.5 8.5v2h-2v1.5h2v2H13v-2h2V10.5h-2v-2h-1.5Z" />,
    refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3.2h-3.2" strokeWidth="1.4" fill="none" />,
    search: <path d="M6.5 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm4.2-.8 3.3 3.3-.9.9-3.3-3.3.9-.9Z" />,
    attach: <path d="M4 13a3.5 3.5 0 0 1-2.5-6l6.8-6.7a2.4 2.4 0 0 1 3.4 3.4L5 10.4a1.3 1.3 0 0 1-1.8-1.8l6.2-6.2-.9-.9L2.3 7.7a2.6 2.6 0 0 0 3.6 3.6l6.7-6.6a3.9 3.9 0 0 0-5.5-5.5L.5 5.9A4.5 4.5 0 0 0 6.9 12.3l6.6-6.6-.9-.9-6.6 6.6A3.5 3.5 0 0 1 4 13Z" transform="scale(0.92)" />,
    send: <path d="M1.5 8 14 2.5 11 13.5l-3.5-3-2 2.5V9L1.5 8Z" />,
    min: <path d="M3 8h10" strokeWidth="1.4" fill="none" />,
    max: <rect x="3" y="3" width="10" height="10" rx="1" fill="none" strokeWidth="1.3" />,
    close: <path d="M3.5 3.5l9 9m0-9l-9 9" strokeWidth="1.4" fill="none" />,
    eye: <path d="M8 3C4.5 3 1.7 5.4.5 8c1.2 2.6 4 5 7.5 5s6.3-2.4 7.5-5C14.3 5.4 11.5 3 8 3Zm0 7.8A2.8 2.8 0 1 1 8 5.2a2.8 2.8 0 0 1 0 5.6Z" />,
    eyeOff: <path d="M2 2l12 12M8 4.5c3 0 5.3 1.9 6.4 3.5-.5.8-1.3 1.7-2.3 2.4M5 5.3C3.6 6 2.5 7.1 1.6 8c1.2 2.6 4 5 7.5 5 1 0 2-.2 2.9-.6M8 6.8a2.8 2.8 0 0 0 2.6 2.9" strokeWidth="1.2" fill="none" />,
    alert: <path d="M8 1.5 15 14H1L8 1.5Zm0 4v4.5m0 1.8v1.2" strokeWidth="1.3" fill="none" />,
    review: <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6L11 12l-3-3-3 3v-3H3.5A1.5 1.5 0 0 1 2 7.5v-4Z" />,
    external: <path d="M9 2h5v5M14 2l-6.5 6.5M11 9v4.5H2.5V5H7" strokeWidth="1.3" fill="none" />,
    spinner: <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" strokeWidth="1.6" fill="none" />,
    dot: <circle cx="8" cy="8" r="3" />,
    git: <g fill="none" strokeWidth="1.4"><circle cx="4" cy="4" r="1.7" /><circle cx="4" cy="12" r="1.7" /><circle cx="12" cy="7" r="1.7" /><path d="M4 5.7v4.6M5.5 4h3.2c1 0 1.8.6 1.8 1.6v0c0 1-.8 1.6-1.8 1.6H5.5M12 8.7v.3c0 1.5-1 2-2.4 2H5.7" /></g>,
    import: <path d="M8 1.5v8.3m0 0L4.8 6.6M8 9.8l3.2-3.2M2 12.5h12" strokeWidth="1.5" fill="none" />,
    browser: <g fill="none" strokeWidth="1.3"><circle cx="8" cy="8" r="6.4" /><path d="M1.6 8h12.8M8 1.6c2.2 1.8 2.2 11 0 12.8M8 1.6c-2.2 1.8-2.2 11 0 12.8" /></g>,
    dots: <g><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></g>
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`icon icon-${name}`} aria-hidden>
      {p[name]}
    </svg>
  )
}

export const AGENT_COLORS: Record<string, string> = {
  orchestrator: 'var(--accent)',
  planner: 'var(--purple)',
  coder: 'var(--accent)',
  reviewer: 'var(--green)',
  debugger: 'var(--amber)',
  researcher: 'var(--teal)'
}

export const AGENT_LABELS: Record<string, string> = {
  orchestrator: 'Meencode',
  planner: 'Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
  debugger: 'Debugger',
  researcher: 'Researcher'
}

export const TOOL_LABELS: Record<string, string> = {
  list_dir: 'listed',
  read_file: 'read',
  write_file: 'wrote',
  edit_file: 'edited',
  delete_file: 'deleted',
  search_files: 'searched',
  grep: 'grepped',
  run_command: 'ran',
  spawn_agent: 'delegated to'
}