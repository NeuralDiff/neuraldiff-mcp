/**
 * NeuralDiff MCP – Escalation Logic
 *
 * Evaluates quick-compare results (and optional pattern matches) to decide
 * whether the MCP should escalate to the daemon's deeper analysis pipeline.
 *
 * Escalation thresholds:
 *   similarity >= 0.98  → no escalation (pages are essentially identical)
 *   0.90 <= sim < 0.98  → escalate at "low" priority (minor drift)
 *   0.75 <= sim < 0.90  → escalate at "medium" priority (noticeable change)
 *   0.50 <= sim < 0.75  → escalate at "high" priority (significant regression)
 *   sim < 0.50          → escalate at "critical" priority (major breakage)
 */

import type {
  EscalationDecision,
  EscalationPriority,
  EscalationReason,
  PatternMatch,
  QuickCompareResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Configurable thresholds
// ---------------------------------------------------------------------------

export interface EscalationThresholds {
  /** Below this similarity the MCP always escalates. Default 0.98. */
  autoEscalate: number;
  /** Bands mapping similarity ranges to priorities. */
  bands: { min: number; max: number; priority: EscalationPriority }[];
}

export const DEFAULT_THRESHOLDS: EscalationThresholds = {
  autoEscalate: 0.98,
  bands: [
    { min: 0.90, max: 0.98, priority: 'low' },
    { min: 0.75, max: 0.90, priority: 'medium' },
    { min: 0.50, max: 0.75, priority: 'high' },
    { min: 0.00, max: 0.50, priority: 'critical' },
  ],
};

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Given a quick-compare result and (optionally) any matched patterns,
 * decide whether to escalate to the daemon for deeper analysis.
 */
export function evaluate(
  compareResult: QuickCompareResult,
  patternMatches: PatternMatch[] = [],
  thresholds: EscalationThresholds = DEFAULT_THRESHOLDS
): EscalationDecision {
  const { similarity } = compareResult;
  const reasons: EscalationReason[] = [];

  // --- Determine base priority from similarity bands ---------------------
  let priority: EscalationPriority = 'low';
  let shouldEscalate = false;

  if (similarity < thresholds.autoEscalate) {
    shouldEscalate = true;

    // Find the matching band.
    for (const band of thresholds.bands) {
      if (similarity >= band.min && similarity < band.max) {
        priority = band.priority;
        break;
      }
    }

    reasons.push({
      code: 'low_similarity',
      message:
        `Similarity ${similarity.toFixed(4)} is below the auto-escalation ` +
        `threshold of ${thresholds.autoEscalate}.`,
    });
  }

  // --- If the daemon itself recommends full analysis ----------------------
  if (compareResult.recommend_full_analysis) {
    shouldEscalate = true;
    reasons.push({
      code: 'daemon_recommendation',
      message: 'The daemon quick-compare flagged this pair for full analysis.',
    });
  }

  // --- Incorporate pattern-based signals ---------------------------------
  for (const match of patternMatches) {
    if (match.pattern.warrantsEscalation) {
      shouldEscalate = true;

      // Promote priority if the pattern is more severe.
      const severityToPriority: Record<string, EscalationPriority> = {
        critical: 'critical',
        error: 'high',
        warning: 'medium',
        info: 'low',
      };
      const patternPriority = severityToPriority[match.pattern.severity] ?? 'medium';
      if (priorityRank(patternPriority) > priorityRank(priority)) {
        priority = patternPriority;
      }

      reasons.push({
        code: 'pattern_match',
        message: `Pattern "${match.pattern.name}" (${match.pattern.severity}) detected with confidence ${match.confidence}.`,
        patternName: match.pattern.name,
      });
    }
  }

  return {
    shouldEscalate,
    priority,
    reasons,
    similarity,
    threshold: thresholds.autoEscalate,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityRank(p: EscalationPriority): number {
  switch (p) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'critical':
      return 4;
  }
}
