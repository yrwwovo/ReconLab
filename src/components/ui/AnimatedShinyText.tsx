import { cn } from '../../lib/utils'

export function AnimatedShinyText({
  children,
  className,
  shimmerWidth = 100,
}: {
  children: React.ReactNode
  className?: string
  shimmerWidth?: number
}) {
  return (
    <p
      className={cn(
        'text-text-dark/70 bg-clip-text inline-flex items-center justify-center',
        className
      )}
      style={{
        backgroundImage: `linear-gradient(120deg, rgba(255,255,255,0) calc(50% - ${shimmerWidth / 2}px), rgba(255,255,255,0.8) 50%, rgba(255,255,255,0) calc(50% + ${shimmerWidth / 2}px))`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        animation: 'shiny-text 8s infinite',
      }}
    >
      {children}
      <style>{`
        @keyframes shiny-text {
          0%, 90%, 100% { background-position: calc(-100% - ${shimmerWidth}px) 0; }
          60%, 80% { background-position: calc(100% + ${shimmerWidth}px) 0; }
        }
      `}</style>
    </p>
  )
}
