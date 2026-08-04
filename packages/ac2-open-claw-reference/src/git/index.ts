/** Git SSH-signing (SSHSIG) domain barrel. */

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
  insertGpgsigHeader,
  resignCommits,
  rewriteParentHeaders,
  stripGpgsigHeader,
  type GitResignOptions,
  type GitResignResult,
} from './resign.js';
export { resolveAc2StateDir } from './config.js';
