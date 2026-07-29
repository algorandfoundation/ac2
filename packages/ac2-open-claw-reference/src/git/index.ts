/** Git SSH-signing (SSHSIG) domain barrel. The `ac2-ssh-sign` shim is standalone in `./shim.js`. */

export {
  SSHSIG_NAMESPACE_GIT,
  assembleSshSigArmor,
  buildSshSigSignedData,
  decodeSshSigArmor,
  encodeSshEd25519PublicKey,
  parseAuthorizedKeyLine,
  toAuthorizedKeyLine,
  verifyEd25519,
  type DecodedSshSig,
} from './sshsig.js';
export {
  GIT_SIGN_SCHEMA,
  describeGitPayload,
  gitSignFlow,
  parseExpectedPublicKey,
  type GitSignParams,
  type GitSignResult,
} from './sign-flow.js';
export {
  ensureGitSignBridge,
  gitSignSocketPath,
  resolveAc2StateDir,
  stopGitSignBridge,
  type GitSignBridgeDeps,
  type GitSignBridgeRequest,
  type GitSignBridgeResponse,
} from './bridge.js';
