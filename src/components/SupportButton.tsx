import Link from 'next/link';
import { support, donationsConfigured } from '@/config';
import { Heart } from 'lucide-react';
import { cn } from '@/lib/cn';

export function SupportButton({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md';
  className?: string;
}) {
  if (!donationsConfigured) return null;

  return (
    <Link
      href={support.href}
      className={cn(
        'inline-flex select-none items-center gap-1.5 whitespace-nowrap rounded-xl bg-accent font-semibold text-accent-ink shadow-sm transition-all hover:brightness-110 active:brightness-95',
        size === 'sm' ? 'h-9 px-3 text-[13px]' : 'h-10 px-4 text-sm',
        className,
      )}
    >
      <Heart
        className={cn('shrink-0 fill-current', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4')}
        aria-hidden
      />
      {support.label}
    </Link>
  );
}
