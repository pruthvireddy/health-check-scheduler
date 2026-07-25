const UNSAFE_CONVERSATIONAL_PATTERNS = [
  /\?/,
  /\b(?:diagnos\w*|disease|condition|medicat\w*|medicine|prescrib\w*|treat\w*)\b/i,
  /\b(?:emergenc\w*|urgent|911|hospital|clinic|appointment)\b/i,
  /\b(?:specialist|doctor|physician|primary care|cardiolog\w*|dermatolog\w*|gastroenterolog\w*|neurolog\w*|orthop\w*|otolaryngolog\w*|ent)\b/i,
  /\b(?:you have|you may have|likely|probably|i think|you should|you need to)\b/i,
  /https?:\/\//i,
] as const;

/**
 * Model wording is only used as a short acknowledgement. Questions, medical
 * claims, care instructions, and scheduling decisions remain application-owned.
 */
export function safeConversationalLead(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 180) return undefined;
  if (UNSAFE_CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return undefined;
  }

  return normalized;
}
