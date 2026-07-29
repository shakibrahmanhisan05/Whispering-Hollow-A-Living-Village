/**
 * Wind for trees, cloth and other objects that want three.js's *full* PBR
 * lighting rather than a custom one.
 *
 * Grass and water justify bespoke shaders — their lighting models are unusual.
 * Trees do not: they want ordinary shadows, ordinary lightmaps, ordinary
 * envmaps, all of which `MeshStandardMaterial` already implements correctly and
 * which would take hundreds of lines to reimplement.
 *
 * So instead of replacing the material, we **patch** it. `onBeforeCompile` lets
 * us splice our wind displacement into three.js's own vertex shader just before
 * it computes the final position, keeping every other feature intact —
 * including shadow casting, because the depth material gets the same patch.
 *
 * @module shaders/foliage
 */

import * as THREE from 'three';
import { glsl, HASH_NOISE, WIND_UNIFORMS, WIND_DISPLACEMENT } from './common.glsl';

/** Uniforms shared by every wind-patched material. */
export interface WindUniforms {
  uTime: { value: number };
  uWindDirection: { value: THREE.Vector2 };
  uWindStrength: { value: number };
  uRipplePhase: { value: number };
  uRippleWavelength: { value: number };
}

export interface FoliageWindOptions {
  /**
   * Bend profile exponent.
   * - `1.2`–`1.6` — soft plants, ferns, hanging moss
   * - `2.2`–`2.8` — leafy branches
   * - `3.5`+ — heavy boughs and trunks that barely move
   */
  stiffness?: number;
  /** Overall displacement multiplier for this object. */
  amplitude?: number;
  /**
   * How the vertex's "height along the plant" is derived.
   * - `'localY'` — use the model-space Y, normalised by `pivotHeight`. Correct
   *   for a tree rooted at its origin.
   * - `'attribute'` — read a per-vertex `aWindWeight` attribute. Needed when
   *   the mesh is instanced or when different parts of one mesh should respond
   *   differently (trunk rigid, canopy loose).
   */
  weightSource?: 'localY' | 'attribute';
  /** Divisor for `'localY'` mode — the object's full height. */
  pivotHeight?: number;
  /** When true, adds a per-instance phase from the instance matrix. */
  instanced?: boolean;
}

/**
 * Patches a material so its vertices are displaced by the global wind field.
 *
 * @param material - Any material compiled from three.js's standard vertex
 *   shader (`MeshStandardMaterial`, `MeshLambertMaterial`, `MeshDepthMaterial`…).
 * @param uniforms - Shared wind uniforms. Pass the *same object* to every
 *   material so one write per frame updates the whole world.
 * @param options - Per-object bend behaviour.
 * @returns The same material, for chaining.
 *
 * @example
 * ```ts
 * const leaves = new THREE.MeshStandardMaterial({ color: 0x3f7a2a });
 * applyFoliageWind(leaves, windUniforms, { stiffness: 2.4, pivotHeight: 8 });
 * ```
 */
export function applyFoliageWind<T extends THREE.Material>(
  material: T,
  uniforms: WindUniforms,
  options: FoliageWindOptions = {},
): T {
  const {
    stiffness = 2.4,
    amplitude = 1,
    weightSource = 'localY',
    pivotHeight = 8,
    instanced = false,
  } = options;

  material.onBeforeCompile = (shader) => {
    // Share the uniform objects by reference — no copying, no per-material sync.
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDirection = uniforms.uWindDirection;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.uniforms.uRipplePhase = uniforms.uRipplePhase;
    shader.uniforms.uRippleWavelength = uniforms.uRippleWavelength;
    shader.uniforms.uFoliageStiffness = { value: stiffness };
    shader.uniforms.uFoliageAmplitude = { value: amplitude };
    shader.uniforms.uPivotHeight = { value: pivotHeight };

    const declarations = glsl`
      uniform float uFoliageStiffness;
      uniform float uFoliageAmplitude;
      uniform float uPivotHeight;
      ${weightSource === 'attribute' ? 'attribute float aWindWeight;' : ''}
      ${HASH_NOISE}
      ${WIND_UNIFORMS}
      ${WIND_DISPLACEMENT}
    `;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${declarations}`,
    );

    /* Inject after <project_vertex>, which is where three.js has just computed
     * `mvPosition`. We need world space to evaluate the wind field, so the
     * displacement is computed in world space and then transformed back into
     * view space by the view matrix — cheaper and more robust than trying to
     * work in object space, which would break under arbitrary rotations. */
    const windChunk = glsl`
      #include <project_vertex>
      {
        vec3 worldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        ${
          instanced
            ? 'vec3 instanceOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;'
            : 'vec3 instanceOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;'
        }

        float heightT = ${
          weightSource === 'attribute'
            ? 'aWindWeight'
            : 'clamp(position.y / max(uPivotHeight, 0.001), 0.0, 1.0)'
        };

        /* Per-instance phase from the world origin, so two trees standing side
         * by side never sway in unison. hash21 avalanches well enough that even
         * adjacent positions give unrelated phases. */
        float phase = hash21(instanceOrigin.xz * 0.37) * 6.2831853;

        vec3 windOffset = windDisplace(instanceOrigin, heightT, uFoliageStiffness, phase)
                        * uFoliageAmplitude;

        vec4 windView = viewMatrix * vec4(windOffset, 0.0);
        mvPosition += windView;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', windChunk);
  };

  /* Materials are cached by their program key. Two materials with identical
   * parameters but different onBeforeCompile patches would otherwise share a
   * program and one patch would silently win. Varying the cache key prevents
   * that. */
  material.customProgramCacheKey = () =>
    `foliage-wind-${stiffness}-${amplitude}-${weightSource}-${pivotHeight}-${instanced}`;

  return material;
}

/**
 * Patches a material so snow accumulates on its upward-facing surfaces.
 *
 * Applied to houses, fences, benches and rocks in winter. Works entirely in the
 * fragment shader from the world normal — no extra geometry, no second draw
 * call, and it responds instantly when the season changes.
 */
export function applySnowAccumulation<T extends THREE.Material>(
  material: T,
  snowUniform: { value: number },
): T {
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uSnowCoverage = snowUniform;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      glsl`
        #include <common>
        uniform float uSnowCoverage;
        varying vec3 vSnowWorldNormal;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      glsl`
        #include <common>
        varying vec3 vSnowWorldNormal;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <defaultnormal_vertex>',
      glsl`
        #include <defaultnormal_vertex>
        vSnowWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      `,
    );

    /* Inject right before the output so snow overrides albedo *after* all the
     * texture and vertex-colour work, but before lighting is applied — snow
     * should be lit, not painted on top of the lighting. */
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      glsl`
        #include <color_fragment>
        if (uSnowCoverage > 0.01) {
          // Steeper than ~50° and the snow slides off.
          float upness = smoothstep(0.35, 0.72, vSnowWorldNormal.y);
          float mask = clamp(upness * uSnowCoverage, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), mask);
        }
      `,
    );
  };

  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey?.() ?? ''}-snow`;
  return material;
}

/**
 * Patches a material to fade out with distance instead of popping.
 *
 * Used on tree LOD tiers so the swap between high-poly and billboard is a
 * dissolve rather than a jump. Uses a screen-space dither pattern and
 * `discard`, which keeps the material in the opaque pass — no transparency
 * sorting, no depth-write compromises.
 */
export function applyLodDither<T extends THREE.Material>(
  material: T,
  uniforms: { uFadeNear: { value: number }; uFadeFar: { value: number }; uFadeInvert: { value: number } },
): T {
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uFadeNear = uniforms.uFadeNear;
    shader.uniforms.uFadeFar = uniforms.uFadeFar;
    shader.uniforms.uFadeInvert = uniforms.uFadeInvert;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      glsl`
        #include <common>
        varying float vLodDistance;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      glsl`
        #include <project_vertex>
        vLodDistance = -mvPosition.z;
      `,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      glsl`
        #include <common>
        uniform float uFadeNear;
        uniform float uFadeFar;
        uniform float uFadeInvert;
        varying float vLodDistance;

        /* 4×4 ordered Bayer matrix. An ordered dither is deliberately chosen
         * over random noise: the pattern is stable frame to frame, so a
         * half-faded tree doesn't shimmer as the camera moves. */
        float bayer4(vec2 p) {
          int x = int(mod(p.x, 4.0));
          int y = int(mod(p.y, 4.0));
          int index = x + y * 4;
          float m[16];
          m[0]=0.0;   m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
          m[4]=12.0;  m[5]=4.0;  m[6]=14.0; m[7]=6.0;
          m[8]=3.0;   m[9]=11.0; m[10]=1.0; m[11]=9.0;
          m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
          for (int i = 0; i < 16; i++) { if (i == index) return m[i] / 16.0; }
          return 0.5;
        }
      `,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      glsl`
        #include <clipping_planes_fragment>
        {
          float t = smoothstep(uFadeNear, uFadeFar, vLodDistance);
          float alpha = uFadeInvert > 0.5 ? t : 1.0 - t;
          if (alpha < bayer4(gl_FragCoord.xy)) discard;
        }
      `,
    );
  };

  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey?.() ?? ''}-loddither`;
  return material;
}
