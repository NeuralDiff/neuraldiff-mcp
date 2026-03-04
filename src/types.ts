/**
 * NeuralDiff MCP – Type Definitions
 *
 * Shared types for escalation logic, pattern detection,
 * analysis pipeline, baselines, watch, and session context.
 */

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Why the MCP is escalating to the daemon / API. */
export interface EscalationReason {
  /** Short machine-readable code, e.g. "low_similarity" */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** Which pattern (if any) triggered this reason. */
  patternName?: string;
}

/** Priority levels – higher means more urgent. */
export type EscalationPriority = 'low' | 'medium' | 'high' | 'critical';

/** The decision returned by the escalation evaluator. */
export interface EscalationDecision {
  /** Whether to escalate to the daemon for deeper analysis. */
  shouldEscalate: boolean;
  /** Priority of the escalation (only meaningful when shouldEscalate is true). */
  priority: EscalationPriority;
  /** One or more reasons justifying the decision. */
  reasons: EscalationReason[];
  /** Similarity score that fed into the decision. */
  similarity: number;
  /** Threshold that was applied. */
  threshold: number;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Severity of a detected visual regression pattern. */
export type PatternSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Indicators that determine whether a pattern matches. */
export interface PatternIndicators {
  /** Maximum similarity score at which this pattern is flagged. */
  maxSimilarity: number;
  /** Minimum similarity score below which this pattern is relevant (optional). */
  minSimilarity?: number;
  /** Additional metadata hints (free-form). */
  hints?: string[];
}

/** A visual regression pattern definition. */
export interface VisualPattern {
  /** Machine-readable name, e.g. "layout-shift". */
  name: string;
  /** Human-readable description. */
  description: string;
  /** How to detect this pattern from hash comparison results. */
  indicators: PatternIndicators;
  /** Severity when this pattern is detected. */
  severity: PatternSeverity;
  /** Whether detection of this pattern should trigger daemon escalation. */
  warrantsEscalation: boolean;
}

/** Result of matching comparison data against known patterns. */
export interface PatternMatch {
  /** The pattern that matched. */
  pattern: VisualPattern;
  /** Confidence of the match (0–1). */
  confidence: number;
  /** Additional detail about why this pattern matched. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Comparison / Analysis
// ---------------------------------------------------------------------------

/** Shape of the daemon's quick-compare response (subset we rely on). */
export interface QuickCompareResult {
  similarity: number;
  hash1: string;
  hash2: string;
  hammingDistance: number;
  recommend_full_analysis: boolean;
  [key: string]: unknown;
}

/** Deep analysis result returned by the daemon's /api/analyze endpoint. */
export interface DaemonAnalysisResult {
  analysisId: string;
  similarity: number;
  regions?: unknown[];
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Diffy's verdict on the analysis. */
export interface DiffyVerdict {
  /** A human-readable verdict from Diffy. */
  verdict: string;
  /** Severity level: clean, minor, moderate, critical. */
  severity: 'clean' | 'minor' | 'moderate' | 'critical';
}

/** Combined result returned by the neuraldiff_analyze tool. */
export interface AnalysisResult {
  /** Diffy's verdict — the headline you should read first. */
  diffy: DiffyVerdict;
  /** Quick compare data. */
  quickCompare: QuickCompareResult;
  /** Patterns matched by the MCP layer. */
  matchedPatterns: PatternMatch[];
  /** Escalation decision. */
  escalation: EscalationDecision;
  /** Deep analysis from the daemon (populated only when escalated). */
  deepAnalysis: DaemonAnalysisResult | null;
  /** ISO timestamp of when the analysis ran. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export interface Baseline {
  /** The unique name for this baseline (often the route or page name). */
  name: string;
  /** The capture ID that serves as the baseline. */
  captureId: string;
  /** When the baseline was set. */
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

export interface WatchOptions {
  /** Polling interval in milliseconds. */
  intervalMs?: number;
  /** Viewport to use for captures. */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };
  /** CSS selector to wait for before capturing. */
  waitFor?: string | number;
  /** Capture full scrollable page. */
  fullPage?: boolean;
}

export interface WatchHandle {
  id: string;
  url: string;
  options: WatchOptions;
  status: 'active' | 'stopped';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session Context
// ---------------------------------------------------------------------------

/** Context sent by the AI agent to help the daemon/API understand changes. */
export interface SessionContext {
  /** A short summary of what the developer intends to change. */
  changeIntent: string;
  /** Summary of recent chat / instruction history. */
  chatHistorySummary?: string;
  /** Affected routes or components. */
  affectedRoutes?: string[];
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}
