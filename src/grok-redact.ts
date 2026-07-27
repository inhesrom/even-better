/** Keep only enough stderr structure to classify failures; never expose this tail. */
export function redactGrokDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
    .replace(/\b(?:eyJ[A-Za-z0-9._-]+|(?:sk|xai)-[A-Za-z0-9_-]{8,})\b/g, "<REDACTED_TOKEN>")
    .replace(/\b(XAI_API_KEY|API_KEY|TOKEN|USER_CODE)\s*[=:]\s*[^\s&]+/gi, "$1=<REDACTED>")
    .replace(/([?&][A-Za-z0-9_.-]+)=([^\s&#]+)/g, "$1=<REDACTED>")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "<REDACTED_EMAIL>")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, "<REDACTED_HOME_PATH>")
    .replace(/\/tmp\/[^\s"']+/g, "<REDACTED_TMP_PATH>")
    .replace(/\b(account|team|agent)(?:_|-)?id\s*[=:]\s*["']?[^\s,"']+/gi, "$1_id=<REDACTED>");
}
