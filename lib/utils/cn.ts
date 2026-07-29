/**
 * Class-name utility.
 *
 * `clsx` handles conditional classes; `tailwind-merge` resolves conflicts by
 * keeping the *last* of any competing Tailwind utilities. Without the merge,
 * `cn('p-4', 'p-2')` produces both classes and the winner depends on
 * stylesheet order rather than call order — which makes component variants
 * unpredictable.
 *
 * @module lib/utils/cn
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
