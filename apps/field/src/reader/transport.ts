/**
 * The transport contract the reader service talks to. Implemented by the
 * simulated transport (dev/test) and the native External Accessory module
 * (production). See `plans/003-…md` Step 3.
 */

/** A byte-stream transport to the TSL reader. */
export interface ReaderTransport {
  /** Open the connection. Resolves once the transport is ready to send/receive. */
  connect(): Promise<void>;
  /** Close the connection. */
  disconnect(): Promise<void>;
  /** Write a command string (already includes any framing) to the reader. */
  send(data: string): void;
  /** Subscribe to incoming chunks; returns an unsubscribe function. */
  onData(cb: (chunk: string) => void): () => void;
  /** Subscribe to connection state changes; returns an unsubscribe function. */
  onConnectionChange(cb: (connected: boolean) => void): () => void;
}
