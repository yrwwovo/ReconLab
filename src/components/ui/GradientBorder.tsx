import { cn } from '../../lib/utils'

export function GradientBorder({
  children,
  className,
  containerClassName,
  gradientClassName,
  animate = true,
}: {
  children: React.ReactNode
  className?: string
  containerClassName?: string
  gradientClassName?: string
  animate?: boolean
}) {
  return (
    <div className={cn('relative rounded-2xl p-[1px]', containerClassName)}>
      <div
        className={cn(
          'absolute inset-0 rounded-2xl',
          animate && 'animate-gradient-border',
          gradientClassName || 'bg-[conic-gradient(from_var(--angle),var(--primary)_0%,transparent_50%,var(--primary)_100%)]'
        )}
        style={{ '--angle': '0deg' } as React.CSSProperties}
      />
      <div className={cn('relative rounded-2xl bg-surface-deep', className)}>
        {children}
      </div>
      <style>{`
        @property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
        @keyframes gradient-border { to { --angle: 360deg; } }
        .animate-gradient-border { animation: gradient-border 4s linear infinite; }
      `}</style>
    </div>
  )
}
