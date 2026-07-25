import type { ContextReview, SymptomEvidence } from "@/lib/validation";

export function approveContextReview(review: ContextReview, approvedAt = new Date().toISOString()): ContextReview {
  return { ...review, approved: true, approvedAt, evidence: review.evidence.map((evidence) => ({ ...evidence, userApproved: true })) };
}

export function unapproveContextReview(review: ContextReview): ContextReview {
  const { approvedAt: _approvedAt, ...unapproved } = review;
  return { ...unapproved, approved: false, evidence: review.evidence.map((evidence) => ({ ...evidence, userApproved: false })) };
}

/** Replaces reviewable facts while preserving provenance for this source. */
export function editContextEvidence(review: ContextReview, evidence: SymptomEvidence[]): ContextReview {
  return {
    ...review,
    approved: false,
    approvedAt: undefined,
    evidence: evidence.map((fact) => ({ ...fact, source: "context_file", sourceLabel: review.sourceFileName, userApproved: false })),
  };
}

export function approvedEvidence(reviews: ContextReview[]): SymptomEvidence[] {
  return reviews.flatMap((review) => (review.approved ? review.evidence.filter((evidence) => evidence.userApproved) : []));
}

export function removeContextReview(reviews: ContextReview[], reviewId: string): ContextReview[] {
  return reviews.filter((review) => review.id !== reviewId);
}
