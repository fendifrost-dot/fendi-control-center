/**
 * Same module as `_shared/agentHubContract.ts`.
 * Kept so agent-hub's own files import `./contract.ts`. The implementation
 * is in _shared because other functions bundle only their folder plus _shared.
 */
export {
  ACTIONS,
  AGENT_AUTHORED_KINDS,
  InputError,
  LIMITS,
  MESSAGE_KINDS,
  OWNER_AUTHORED_KINDS,
  PURPOSES,
  RESERVED_KINDS,
  attachments,
  authoredKind,
  buildPacket,
  effectiveAvailability,
  isAction,
  oneOf,
  renderPacket,
  responseKindFor,
  str,
  uuid,
  workContext,
} from "../_shared/agentHubContract.ts";

export type {
  Action,
  AgentRow,
  Attachment,
  Effective,
  MessageKind,
  Packet,
  PacketMessage,
  Purpose,
  WorkContext,
} from "../_shared/agentHubContract.ts";
