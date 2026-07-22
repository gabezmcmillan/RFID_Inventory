/**
 * Printer TCP client — raw ZPL over TCP/9100 to the Zebra ZD621R, a TypeScript
 * port of `apps/warehouse/printer.py`'s `_send_tcp` (printer.py:148-157) and
 * `_status_tcp` (printer.py:286-321). The Windows spooler USB path is retired
 * with the PC; the phone reaches the printer over the warehouse LAN only.
 *
 * `react-native-tcp-socket` is a native (legacy-bridge) module, so it is loaded
 * with a dynamic `import()` inside each call — mirroring the tsl-transport
 * pattern — so the simulated/no-printer path never pulls or evaluates it. The
 * gate is the JS bundle (`expo export`); the native build is plan 010's cutover.
 */

import type TCPSocketNamespace from "react-native-tcp-socket";

/** Operator-safe health check result (mirrors `printer.status`). */
export interface PrinterStatus {
  readonly ok: boolean;
  readonly message: string;
}

type Socket = TCPSocketNamespace.Socket;

/** Default Zebra raw-ZPL port (config.py `PRINTER_PORT`). */
export const PRINTER_PORT = 9100;

/** Connect timeout (ms) for sending a label (printer.py `_send_tcp` timeout=5). */
const SEND_TIMEOUT_MS = 5000;
/** Connect + read-idle timeout (ms) for the `~HS` status query (printer.py `status` timeout=3). */
const STATUS_TIMEOUT_MS = 3000;
/** `~HS` answers with three STX…ETX strings; collect until three ETX (0x03) bytes. */
const STATUS_ETX_COUNT = 3;

/** Lazily load the native TCP module (dynamic so it stays out of the default bundle). */
async function loadTcp(): Promise<typeof TCPSocketNamespace> {
  const mod = await import("react-native-tcp-socket");
  return mod.default as typeof TCPSocketNamespace;
}

/**
 * Build the operator-safe "printer unreachable" message — port of
 * `printer._send_tcp`'s `except OSError` branch (printer.py:154-157).
 */
function unreachable(host: string, port: number, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Printer unreachable at ${host}:${port} (${detail})`;
}

/**
 * Send one ZPL job to the printer and close — port of `printer._send_tcp`
 * (printer.py:148-157). Connects with a 5 s timeout, writes the ZPL as ASCII
 * (replacing non-ASCII chars, like Python's `encode("ascii", "replace")`),
 * and closes once the data is flushed. Rejects with an operator-safe message
 * if the printer can't be reached.
 */
export async function sendZpl(host: string, port: number, zpl: string): Promise<void> {
  const TCPSocket = await loadTcp();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error(unreachable(host, port, err)));
    };
    const ok = (): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };

    const socket: Socket = TCPSocket.createConnection(
      { port, host, connectTimeout: SEND_TIMEOUT_MS },
      () => {
        // Connected: write the ZPL, then close once it is flushed to the OS.
        socket.write(zpl, "ascii", () => ok());
      },
    );

    socket.on("error", (err: Error) => fail(err));
    socket.on("timeout", () => fail(new Error("connect/write timed out")));
  });
}

/**
 * Printer health check over TCP — port of `printer._status_tcp`
 * (printer.py:286-321). Sends `~HS`, collects until three ETX (0x03) bytes (or
 * the printer closes / a read-idle timeout), then parses media-out / paused /
 * printhead-open from the first two comma-delimited status strings. An
 * unparseable reply from an answering printer still counts as alive.
 */
export async function printerStatus(
  host: string,
  port: number,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<PrinterStatus> {
  const TCPSocket = await loadTcp();
  return new Promise<PrinterStatus>((resolve) => {
    let settled = false;
    let data = "";

    const finish = (status: PrinterStatus): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(status);
    };

    const parse = (): PrinterStatus => {
      try {
        const parts = data.split("\x03").map((s) => s.replace(/^[\r\n\x02]+|[\r\n\x02]+$/g, ""));
        const s1 = parts[0]?.split(",") ?? [];
        const s2 = parts[1]?.split(",") ?? [];
        const problems: string[] = [];
        if (s1[1] === "1") problems.push("media out");
        if (s1[2] === "1") problems.push("paused");
        if (s2[1] === "1") problems.push("printhead open");
        if (problems.length > 0) {
          return { ok: false, message: `Printer: ${problems.join(", ")}` };
        }
        return { ok: true, message: "Printer ready." };
      } catch {
        // It answered on the ZPL port; treat unparseable status as alive.
        return { ok: true, message: "Printer answered." };
      }
    };

    const socket: Socket = TCPSocket.createConnection(
      { port, host, connectTimeout: timeoutMs },
      () => {
        socket.write("~HS", "ascii");
        socket.setEncoding("latin1");
        socket.setTimeout(timeoutMs);
      },
    );

    socket.on("data", (chunk: unknown) => {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      data += text;
      if (data.split("\x03").length - 1 >= STATUS_ETX_COUNT) {
        finish(parse());
      }
    });
    socket.on("close", () => {
      // Printer closed the reply (may be < 3 ETX); parse whatever we have.
      finish(parse());
    });
    socket.on("timeout", () => {
      finish({ ok: false, message: unreachable(host, port, new Error("status query timed out")) });
    });
    socket.on("error", (err: Error) => {
      finish({ ok: false, message: unreachable(host, port, err) });
    });
  });
}
