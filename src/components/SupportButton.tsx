import Link from 'next/link';
import { support, donationsConfigured } from '@/config';
import { Heart } from 'lucide-react';
import { cn } from '@/lib/cn';

export function SupportButton({
  size = 'md',
  compact = false,
  className,
}: {
  size?: 'sm' | 'md';
  /** Heart only until there is room for the label. For the header. */
  compact?: boolean;
  className?: string;
}) {
  if (!donationsConfigured) return null;

  return (
    <Link
      href={support.href}
      aria-label={compact ? support.label : undefined}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-accent font-semibold text-accent-ink shadow-sm transition-all hover:brightness-110 active:brightness-95',
        compact
          ? 'h-9 w-9 text-[13px] sm:w-auto sm:px-3'
          : size === 'sm'
            ? 'h-9 px-3 text-[13px]'
            : 'h-10 px-4 text-sm',
        className,
      )}
    >
      <Heart className="h-4 w-4 shrink-0 fill-current" aria-hidden />
      <span className={compact ? 'hidden sm:inline' : undefined}>{support.label}</span>
    </Link>
  );
}
