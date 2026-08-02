export function phaseComplete(exitCode: number | null, deliverableDelivered?: boolean) {
  return deliverableDelivered ?? exitCode === 0;
}
