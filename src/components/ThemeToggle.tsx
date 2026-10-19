import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';

export function ThemeToggle({ labelled = false }: { labelled?: boolean }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('free-secure-kit:theme', next);
    } catch {
      // localStorage throws in some private windows; the theme just won't stick
    }
  }

  const icon =
    theme === null ? null : theme === 'dark' ? (
      <Sun className="h-4 w-4 shrink-0" aria-hidden />
    ) : (
      <Moon className="h-4 w-4 shrink-0" aria-hidden />
    );

  if (labelled) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-ink"
      >
        {icon}
        {theme === null ? null : <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:text-ink"
    >
      {icon}
    </button>
  );
}
