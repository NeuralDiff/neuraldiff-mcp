/**
 * NeuralDiff MCP – Visual Regression Pattern Definitions
 *
 * These patterns let the MCP layer do fast, heuristic-based triage of
 * comparison results *before* escalating to the daemon for deeper analysis.
 *
 * Each pattern is characterised by hash-similarity thresholds that act
 * as proxy signals for common categories of visual regression.
 */

import type { PatternMatch, QuickCompareResult, VisualPattern } from './types.js';

// ---------------------------------------------------------------------------
// Pattern catalogue
// ---------------------------------------------------------------------------

export const PATTERNS: VisualPattern[] = [
  // -- Layout shift --------------------------------------------------------
  {
    name: 'layout-shift',
    description:
      'Significant structural change detected – elements may have moved, resized, or reflowed. ' +
      'Common after CSS grid/flexbox changes or container resizing.',
    indicators: {
      maxSimilarity: 0.75,
      minSimilarity: 0.35,
      hints: ['grid', 'flex', 'position', 'layout'],
    },
    severity: 'error',
    warrantsEscalation: true,
  },

  // -- Color change --------------------------------------------------------
  {
    name: 'color-change',
    description:
      'Moderate perceptual difference consistent with colour palette or theme changes. ' +
      'Hash algorithms are sensitive to global brightness / hue shifts.',
    indicators: {
      maxSimilarity: 0.92,
      minSimilarity: 0.76,
      hints: ['color', 'theme', 'palette', 'background'],
    },
    severity: 'warning',
    warrantsEscalation: true,
  },

  // -- Typography change ---------------------------------------------------
  {
    name: 'typography-change',
    description:
      'Subtle difference that may indicate font-family, font-size, line-height, or ' +
      'letter-spacing changes. Perceptual hashes pick these up as small-but-consistent diffs.',
    indicators: {
      maxSimilarity: 0.95,
      minSimilarity: 0.85,
      hints: ['font', 'text', 'typography', 'line-height'],
    },
    severity: 'warning',
    warrantsEscalation: false,
  },

  // -- Spacing change ------------------------------------------------------
  {
    name: 'spacing-change',
    description:
      'Minor positional shifts consistent with margin, padding, or gap adjustments. ' +
      'Usually not visually breaking but worth reviewing.',
    indicators: {
      maxSimilarity: 0.96,
      minSimilarity: 0.88,
      hints: ['margin', 'padding', 'gap', 'spacing'],
    },
    severity: 'info',
    warrantsEscalation: false,
  },

  // -- Component visibility -----------------------------------------------
  {
    name: 'component-visibility',
    description:
      'Large structural change – likely a component has appeared, disappeared, or changed ' +
      'display/visibility. Hash similarity drops sharply.',
    indicators: {
      maxSimilarity: 0.35,
      hints: ['display', 'visibility', 'hidden', 'modal', 'drawer'],
    },
    severity: 'critical',
    warrantsEscalation: true,
  },
];

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

/**
 * Run the comparison result against all known patterns and return every
 * pattern whose similarity-band contains the observed similarity score.
 *
 * Confidence is computed as the normalised distance from the centre of
 * the pattern's similarity window – closer to the centre means higher
 * confidence that this pattern explains the diff.
 */
export function matchPatterns(compareResult: QuickCompareResult): PatternMatch[] {
  const { similarity } = compareResult;
  const matches: PatternMatch[] = [];

  for (const pattern of PATTERNS) {
    const { maxSimilarity, minSimilarity = 0 } = pattern.indicators;

    if (similarity <= maxSimilarity && similarity >= minSimilarity) {
      // Confidence: 1.0 at the centre of the band, tapering toward edges.
      const bandWidth = maxSimilarity - minSimilarity;
      const centre = minSimilarity + bandWidth / 2;
      const distFromCentre = Math.abs(similarity - centre);
      const confidence =
        bandWidth > 0 ? Math.max(0, 1 - distFromCentre / (bandWidth / 2)) : 1;

      matches.push({
        pattern,
        confidence: Math.round(confidence * 1000) / 1000,
        detail:
          `Similarity ${similarity.toFixed(4)} falls within the ` +
          `${pattern.name} band [${minSimilarity}, ${maxSimilarity}]. ` +
          `Severity: ${pattern.severity}.`,
      });
    }
  }

  // Sort by confidence descending so the best match is first.
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

/**
 * Convenience: do any of the matched patterns warrant escalation?
 */
export function anyPatternWarrantsEscalation(matches: PatternMatch[]): boolean {
  return matches.some((m) => m.pattern.warrantsEscalation);
}
