import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './theme'
import './styles.css'

initTheme()

// Load Poppins from Google Fonts for a cleaner, VS Code-like UI.
const link = document.createElement('link')
link.rel = 'stylesheet'
link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap'
document.head.appendChild(link)

createRoot(document.getElementById('root')!).render(<App />)