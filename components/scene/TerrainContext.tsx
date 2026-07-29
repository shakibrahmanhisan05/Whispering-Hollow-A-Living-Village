/**
 * Shares the generated {@link TerrainData} with the whole scene.
 *
 * Nearly everything in the world needs to ask "how high is the ground here?" —
 * tree scatter, prop placement, the player controller, wildlife, grass chunks,
 * water edges. Threading the terrain through props would mean passing it
 * through a dozen intermediate components, so it goes through context instead.
 *
 * The value is a plain object, not state: `TerrainData` is immutable once
 * generated, so nothing re-renders when it is read.
 *
 * @module components/scene/TerrainContext
 */

'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type * as THREE from 'three';
import type { TerrainData } from '@/lib/terrain/generate';
import type { WindUniforms } from '@/shaders/foliage.glsl';

export interface WorldContextValue {
  terrain: TerrainData;
  /** Shared wind uniforms — the same object every wind-aware material uses. */
  windUniforms: WindUniforms;
  /** Height texture for shaders that plant geometry on the terrain. */
  heightTexture: THREE.DataTexture;
}

const WorldContext = createContext<WorldContextValue | null>(null);

export function WorldProvider({
  value,
  children,
}: {
  value: WorldContextValue;
  children: ReactNode;
}) {
  return <WorldContext.Provider value={value}>{children}</WorldContext.Provider>;
}

/**
 * Reads the world context.
 * @throws When called outside a `<WorldProvider>` — always a programming error.
 */
export function useWorld(): WorldContextValue {
  const ctx = useContext(WorldContext);
  if (!ctx) throw new Error('useWorld must be used inside <WorldProvider>');
  return ctx;
}

/** Convenience: just the terrain. */
export function useTerrain(): TerrainData {
  return useWorld().terrain;
}
