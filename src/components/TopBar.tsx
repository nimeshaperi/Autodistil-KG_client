import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'

export default function TopBar() {
  const { theme, toggle } = useTheme()

  return (
    <header className="h-12 border-b border-border/50 bg-card/60 backdrop-blur-sm flex items-center justify-between px-4 shrink-0">
      <span className="text-sm text-muted-foreground">Pipeline Dashboard</span>
      <button
        onClick={toggle}
        className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>
    </header>
  )
}
