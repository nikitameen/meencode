import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    switch (label) {
      case 'json': return new jsonWorker()
      case 'css': case 'scss': case 'less': return new cssWorker()
      case 'html': case 'handlebars': case 'razor': return new htmlWorker()
      case 'typescript': case 'javascript': return new tsWorker()
      default: return new editorWorker()
    }
  }
}

monaco.editor.defineTheme('meencode-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5b6372', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b48cff' },
    { token: 'string', foreground: '7fd08a' },
    { token: 'number', foreground: 'f2a56e' },
    { token: 'type', foreground: '6fc3ff' },
    { token: 'function', foreground: '66c2ff' },
    { token: 'variable', foreground: 'd7dce5' }
  ],
  colors: {
    'editor.background': '#11141b',
    'editor.lineHighlightBackground': '#161a2300',
    'editorLineNumber.foreground': '#39404e',
    'editorLineNumber.activeForeground': '#8b93a3',
    'editorIndentGuide.background': '#1c212b',
    'editor.selectionBackground': '#2a3f5f',
    'editorCursor.foreground': '#4f8cff',
    'editorWidget.background': '#161a23',
    'editorWidget.border': '#1f2430',
    'editorGutter.background': '#11141b',
    'scrollbarSlider.background': '#22273388',
    'scrollbarSlider.hoverBackground': '#2c324480'
  }
})

monaco.editor.defineTheme('meencode-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a919e', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'string', foreground: '16a34a' },
    { token: 'number', foreground: 'b45309' },
    { token: 'type', foreground: '2563eb' },
    { token: 'function', foreground: '1d4ed8' },
    { token: 'variable', foreground: '1f2430' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f0f2f500',
    'editorLineNumber.foreground': '#a8b0bd',
    'editorLineNumber.activeForeground': '#5a6272',
    'editorIndentGuide.background': '#e4e7ec',
    'editor.selectionBackground': '#b3d1ff',
    'editorCursor.foreground': '#2563eb',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d8dce4',
    'editorGutter.background': '#ffffff',
    'scrollbarSlider.background': '#c4cad688',
    'scrollbarSlider.hoverBackground': '#aab2c280'
  }
})

monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.React,
  allowNonTsExtensions: true,
  esModuleInterop: true
})

monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})

export { monaco }