/**
 * Printer settings — the per-device printer host and cloud base URL, persisted
 * in `AsyncStorage` (mirroring the Python app's `settings.ini` keys
 * `PRINTER_HOST` / `CLOUD_URL`). `printer_host` empty means printing is disabled
 * (printer.py `enabled()`, printer.py:117-118); `cloud_base_url` empty means no
 * QR code on the label (full cloud sync config arrives in plan 010).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

/** AsyncStorage key for the printer's warehouse-LAN IP (empty = disabled). */
export const PRINTER_HOST_KEY = "rfid.field.printerHost";
/** AsyncStorage key for the cloud base URL used to build label QR URLs (empty = no QR). */
export const CLOUD_BASE_URL_KEY = "rfid.field.cloudBaseUrl";
/** Default Zebra raw-ZPL port (config.py `PRINTER_PORT`); effectively never changes. */
export const PRINTER_PORT = 9100;

/** The persisted printer settings. */
export interface PrinterSettings {
  readonly printerHost: string;
  readonly cloudBaseUrl: string;
}

/** Default (unset) printer settings: printing and QR both off. */
export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  printerHost: "",
  cloudBaseUrl: "",
};

/** Load the persisted printer settings (defaults when unset). */
export async function loadPrinterSettings(): Promise<PrinterSettings> {
  const [host, cloud] = await Promise.all([
    AsyncStorage.getItem(PRINTER_HOST_KEY),
    AsyncStorage.getItem(CLOUD_BASE_URL_KEY),
  ]);
  return {
    printerHost: host ?? "",
    cloudBaseUrl: cloud ?? "",
  };
}

/** Persist the printer host (empty string disables printing). */
export async function savePrinterHost(host: string): Promise<void> {
  await AsyncStorage.setItem(PRINTER_HOST_KEY, host);
}

/** Persist the cloud base URL (empty string disables label QR codes). */
export async function saveCloudBaseUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(CLOUD_BASE_URL_KEY, url);
}

/**
 * Whether printing is enabled — true when a printer host is configured
 * (printer.py `enabled()`, printer.py:117-118, minus the retired USB queue).
 */
export function printingEnabled(settings: PrinterSettings): boolean {
  return settings.printerHost.trim().length > 0;
}

/**
 * Build the label QR URL for an EPC — `{cloudBaseUrl}/tag/{epc}` when a cloud
 * base is configured, else `""` (no QR). Mirrors intake.py:111,126.
 */
export function qrUrlFor(settings: PrinterSettings, epc: string): string {
  const base = settings.cloudBaseUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/tag/${epc}` : "";
}
