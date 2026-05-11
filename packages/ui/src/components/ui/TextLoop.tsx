import { cn } from '@/lib/utils';
import {
  motion,
  AnimatePresence,
} from 'motion/react';
import type {
  Transition,
  Variants,
  AnimatePresenceProps,
} from 'motion/react';
import { useState, useEffect, Children } from 'react';

export type TextLoopProps = {
  children: React.ReactNode[];
  className?: string;
  interval?: number;
  transition?: Transition;
  variants?: Variants;
  onIndexChange?: (index: number) => void;
  trigger?: boolean;
  mode?: AnimatePresenceProps['mode'];
};

export function TextLoop({
  children,
  className,
  interval = 2,
  transition = { duration: 0.3 },
  variants,
  onIndexChange,
  trigger = true,
  mode = 'popLayout',
}: TextLoopProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const items = Children.toArray(children);

  useEffect(() => {
    let next = currentIndex;
    if (items.length === 0) {
      next = 0;
    } else if (!Number.isInteger(currentIndex) || currentIndex < 0) {
      next = 0;
    } else if (currentIndex >= items.length) {
      next = items.length - 1;
    }

    if (next !== currentIndex) {
      setCurrentIndex(next);
      onIndexChange?.(next);
    }
  }, [currentIndex, items.length, onIndexChange]);

  useEffect(() => {
    if (!trigger || items.length <= 1) return;

    const intervalMs = interval * 1000;
    const timer = setInterval(() => {
      setCurrentIndex((current) => {
        const next = (current + 1) % items.length;
        onIndexChange?.(next);
        return next;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [items.length, interval, onIndexChange, trigger]);

  const motionVariants: Variants = {
    initial: { y: 20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -20, opacity: 0 },
  };

  return (
    <div className={cn('relative', className)}>
      {/* Invisible element to maintain consistent width based on longest item */}
      <div className="invisible whitespace-nowrap">
        {items.map((item, i) => (
          <div key={i} className={i === 0 ? '' : 'absolute'}>{item}</div>
        ))}
      </div>
      {/* Animated visible element */}
      <div className="absolute inset-0 flex items-center justify-center">
        <AnimatePresence mode={mode} initial={false}>
          <motion.div
            key={currentIndex}
            initial='initial'
            animate='animate'
            exit='exit'
            transition={transition}
            variants={variants || motionVariants}
            className="absolute whitespace-nowrap"
          >
            {items[currentIndex]}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
