/** Credential-shaped strings are replaced before data leaves the agent. */
const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|secret:\/\/[^\s]+)/g

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, '<redacted>')
}
