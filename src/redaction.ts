const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]+(?:[^\s/@]*))@/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const GITHUB_CLASSIC_PAT_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/gu;
const GITHUB_FINE_GRAINED_PAT_PATTERN = /\bgithub_pat_[A-Za-z0-9_]+\b/giu;
const TOKEN_KEY_PATTERN = /\b(token|access_token|authorization|github_token|gh_token)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/giu;

export function redactSecrets(value: string, tokens: readonly string[] = []): string {
  let redacted = value;

  for (const token of tokens) {
    if (!token) continue;
    redacted = redacted.split(token).join("[REDACTED]");
  }

  redacted = redacted.replace(URL_USERINFO_PATTERN, "$1[REDACTED]@");
  redacted = redacted.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  redacted = redacted.replace(GITHUB_CLASSIC_PAT_PATTERN, "[REDACTED]");
  redacted = redacted.replace(GITHUB_FINE_GRAINED_PAT_PATTERN, "[REDACTED]");
  redacted = redacted.replace(TOKEN_KEY_PATTERN, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);

  return redacted;
}
