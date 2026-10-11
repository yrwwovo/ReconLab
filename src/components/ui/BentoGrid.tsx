import { cn } from '../../lib/utils'

export function BentoGrid({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={cn('grid grid-cols-1 md:grid-cols-3 gap-4 max-w-7xl mx-auto', className)}>
      {children}
    </div>
  )
}

export function BentoGridItem({
  className,
  title,
  description,
  header,
  icon,
}: {
  className?: string
  title?: string | React.ReactNode
  description?: string | React.ReactNode
  header?: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'row-span-1 rounded-2xl group/bento transition-all duration-300 p-4 border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.1] hover:shadow-xl',
        className
      )}
    >
      {header}
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-2">
          {icon}
          <div className="font-title text-lg text-text-light group-hover/bento:translate-x-1 transition-transform duration-300">
            {title}
          </div>
        </div>
        <div className="text-sm text-text-dark leading-relaxed">{description}</div>
      </div>
    </div>
  )
}
