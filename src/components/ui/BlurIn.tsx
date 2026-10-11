import { motion } from 'framer-motion'
import { cn } from '../../lib/utils'

export function BlurIn({
  children,
  className,
  duration = 0.8,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  duration?: number
  delay?: number
}) {
  return (
    <motion.div
      initial={{ filter: 'blur(20px)', opacity: 0 }}
      animate={{ filter: 'blur(0px)', opacity: 1 }}
      transition={{ duration, delay }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}
