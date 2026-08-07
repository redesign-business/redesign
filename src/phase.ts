export function phaseComplete(exitCode: number | null, deliverableDelivered?: boolean) {
  return deliverableDelivered ?? exitCode === 0;
}

export function redactSessionOutput(output: string, secrets: Array<string | undefined>) {
  return secrets
    .filter((secret): secret is string => Boolean(secret && secret.length >= 8))
    .reduce((safeOutput, secret) => safeOutput.replaceAll(secret, "[REDACTED]"), output);
}
