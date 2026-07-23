/**
 * Field auth barrel — the single import surface for the stored device-linking
 * credential. Future server-sync work (plan 010) imports the bearer token here
 * to authenticate phone→server requests (`Authorization: Bearer <token>`); the
 * web app's `bearer` plugin resolves it to a session.
 */
export {
  clearLinkedCredential,
  DEFAULT_SERVER_URL,
  exchangeOneTimeToken,
  getLinkedCredential,
  getLinkedIdentity,
  getLinkedToken,
  getServerUrl,
  isDeviceLinked,
  isLocalPrivateHost,
  type LinkedCredential,
  type LinkedIdentity,
  normalizeServerUrl,
  SERVER_URL_KEY,
  type ServerUrlValidation,
  setServerUrl,
  testServerConnection,
  trySetServerUrl,
  unreachableServerMessage,
  validateServerUrl,
} from "./credential";
