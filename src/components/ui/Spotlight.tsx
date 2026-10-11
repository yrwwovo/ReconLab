import { cn } from '../../lib/utils'

export function Spotlight({
  className,
  fill = 'white',
}: {
  className?: string
  fill?: string
}) {
  return (
    <svg
      className={cn(
        'animate-spotlight pointer-events-none absolute z-[1] h-[169%] w-[138%] lg:w-[84%] opacity-0',
        className
      )}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 3787 2842"
      fill="none"
    >
      <g filter="url(#filter)">
        <ellipse
          cx="1924.71"
          cy="273.501"
          rx="1924.71"
          ry="273.501"
          transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
          fill={fill}
          fillOpacity="0.21"
        />
      </g>
      <defs>
        <filter id="filter" x="0" y="0" width="3787" height="2842" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="bg" />
          <feBlend mode="normal" in="SourceGraphic" in2="bg" result="shape" />
          <feGaussianBlur stdDeviation="151" result="blur" />
        </filter>
      </defs>
      <style>{`
        @keyframes spotlight { 0% { opacity: 0; transform: translate(-72%, -62%) scale(0.5); } 100% { opacity: 1; transform: translate(-50%, -40%) scale(1); } }
        .animate-spotlight { animation: spotlight 2s ease forwards 0.15s; }
      `}</style>
    </svg>
  )
}
