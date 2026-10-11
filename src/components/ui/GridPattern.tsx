import { useId } from 'react'
import { cn } from '../../lib/utils'

interface GridPatternProps {
  width?: number
  height?: number
  strokeDasharray?: string
  className?: string
  squares?: [number, number][]
}

export function GridPattern({
  width = 40,
  height = 40,
  strokeDasharray = '0',
  className,
  squares,
}: GridPatternProps) {
  const id = useId()

  return (
    <svg
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 h-full w-full fill-text-dark/[0.04] stroke-text-dark/[0.06]',
        className
      )}
    >
      <defs>
        <pattern id={id} width={width} height={height} patternUnits="userSpaceOnUse">
          <path d={`M.5 ${height}V.5H${width}`} fill="none" strokeDasharray={strokeDasharray} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
      {squares && (
        <svg className="overflow-visible">
          {squares.map(([x, y], idx) => (
            <rect
              key={idx}
              width={width - 1}
              height={height - 1}
              x={x * width + 1}
              y={y * height + 1}
              strokeWidth="0"
            />
          ))}
        </svg>
      )}
    </svg>
  )
}
