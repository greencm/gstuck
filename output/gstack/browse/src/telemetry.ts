// [gstuck] Browse telemetry disabled.
export interface TelemetryEvent { event: string; [key: string]: unknown; }
export function logTelemetry(_payload: TelemetryEvent): void {}
export function _resetTelemetryCache(): void {}
