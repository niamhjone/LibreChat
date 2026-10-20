/**
 * Pendo Track Events for this fork's deployment (see FORK.md). The app never loads Pendo
 * itself: when a deployment installs the Pendo snippet, `window.pendo` exists and these calls
 * reach it; otherwise every call is a no-op.
 *
 * `tool_credentials_updated` and `endpoint_api_key_saved` are sent from shared React Query
 * hooks instead, through `packages/data-provider/src/react-query/pendo.ts`, and
 * `scheduled_run_completed` from the server, through `packages/api/src/pendo.ts`.
 */
import { parseLangChainErrorCode } from 'librechat-data-provider';
import { extractJson } from '~/utils/json';

/** Event names exactly as registered in Pendo, which matches them verbatim: a renamed event
 *  reads as a new, empty track type. */
export type PendoTrackEvent =
  /* Chat */
  | 'chat_message_sent'
  | 'chat_response_completed'
  | 'chat_response_failed'
  | 'chat_generation_stopped'
  | 'conversation_created'
  | 'message_feedback_submitted'
  | 'message_edited'
  | 'conversation_forked'
  | 'parallel_response_branched'
  | 'tool_approval_submitted'
  | 'agent_question_answered'
  | 'steer_message_sent'
  | 'chat_followup_queued'
  | 'file_uploaded'
  | 'file_upload_failed'
  | 'files_deleted'
  | 'model_selected'
  | 'voice_input_transcribed'
  | 'code_block_executed'
  | 'artifact_downloaded'
  | 'artifact_edit_saved'
  /* Conversations */
  | 'conversation_search_performed'
  | 'conversation_deleted'
  | 'conversation_archived'
  | 'all_conversations_archived'
  | 'all_conversations_deleted'
  | 'conversation_pinned'
  | 'conversation_renamed'
  | 'conversation_duplicated'
  | 'conversation_bookmark_toggled'
  | 'bookmark_saved'
  | 'conversations_imported'
  | 'conversation_exported'
  /* Projects */
  | 'project_created'
  | 'project_updated'
  | 'project_deleted'
  | 'conversation_assigned_to_project'
  | 'project_file_added'
  /* Agents, schedules and API keys */
  | 'agent_created'
  | 'agent_updated'
  | 'agent_deleted'
  | 'agent_duplicated'
  | 'agent_version_reverted'
  | 'agent_action_saved'
  | 'agent_marketplace_searched'
  | 'agent_chat_started_from_marketplace'
  | 'favorite_toggled'
  | 'schedule_created'
  | 'schedule_updated'
  | 'schedule_run_triggered'
  | 'schedule_deleted'
  | 'agent_api_key_created'
  /* Prompts and skills */
  | 'prompt_created'
  | 'prompt_version_saved'
  | 'prompt_used'
  | 'prompt_deleted'
  | 'prompt_library_searched'
  | 'skill_created'
  | 'skill_imported'
  | 'skill_updated'
  | 'skill_deleted'
  | 'skill_toggled'
  | 'skill_library_searched'
  /* Memories */
  | 'memory_created'
  | 'memory_updated'
  | 'memory_deleted'
  | 'memory_preference_changed'
  | 'ai_memory_updated'
  /* Integrations */
  | 'mcp_server_created'
  | 'mcp_server_updated'
  | 'mcp_server_deleted'
  | 'mcp_server_connected'
  | 'mcp_server_connection_failed'
  | 'endpoint_api_key_revoked'
  | 'langfuse_connection_saved'
  | 'code_environment_paired'
  | 'code_environment_ready'
  /* Insights */
  | 'insights_report_viewed'
  /* Sharing and permissions */
  | 'shared_link_created'
  | 'shared_link_updated'
  | 'shared_link_deleted'
  | 'shared_conversation_forked'
  | 'resource_permissions_updated'
  | 'role_permissions_updated'
  /* Authentication */
  | 'user_logged_in'
  | 'login_failed'
  | 'user_registered'
  | 'user_logged_out'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'two_factor_enabled'
  | 'two_factor_disabled'
  | 'passkey_registered'
  | 'email_verified'
  | 'terms_accepted'
  /* Account */
  | 'account_deleted'
  | 'avatar_uploaded'
  | 'email_change_requested'
  /* Errors */
  | 'client_error_boundary_triggered';

/** Strings and booleans group in Pendo's Data Explorer; numbers aggregate. */
export type PendoPropertyValue = string | number | boolean | string[] | null | undefined;
export type PendoProperties = Record<string, PendoPropertyValue>;

type PendoAgent = {
  track: (event: string, properties?: PendoProperties) => void;
};

/** Pendo's limit for a Track Event's properties, measured as `{"properties":{...}}`. */
const MAX_PROPERTIES_BYTES = 512;
/** A long string would crowd every other property out of that limit. */
const MAX_STRING_LENGTH = 100;

const isPendoAgent = (value: unknown): value is PendoAgent =>
  typeof value === 'object' &&
  value !== null &&
  'track' in value &&
  typeof value.track === 'function';

/**
 * Drops unset values and caps strings, then removes trailing properties until the payload
 * fits Pendo's limit. Call sites therefore list their properties most important first.
 */
export function fitProperties(properties: PendoProperties): PendoProperties {
  const entries: Array<[string, PendoPropertyValue]> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    entries.push([key, typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value]);
  }
  const encoder = new TextEncoder();
  let fitted: PendoProperties = Object.fromEntries(entries);
  while (
    entries.length > 0 &&
    encoder.encode(JSON.stringify({ properties: fitted })).length > MAX_PROPERTIES_BYTES
  ) {
    entries.pop();
    fitted = Object.fromEntries(entries);
  }
  return fitted;
}

/** Sends a Track Event when Pendo is loaded. Never throws: analytics must not break the
 *  action it records. */
function track(event: PendoTrackEvent, properties: PendoProperties = {}): void {
  const agent: unknown = typeof window === 'undefined' ? undefined : Reflect.get(window, 'pendo');
  if (!isPendoAgent(agent)) {
    return;
  }
  try {
    agent.track(event, fitProperties(properties));
  } catch {
    /* Deliberately swallowed; see above. */
  }
}

/** Mirrors the Pendo agent's API, so call sites read `pendo.track(event, properties)`. */
export const pendo = { track };

/** A file name's extension, lowercased, so the name itself never reaches Pendo. */
export function toFileExtension(name: string | undefined): string | undefined {
  const dot = name?.lastIndexOf('.') ?? -1;
  if (name == null || dot <= 0) {
    return undefined;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : undefined;
}

/** An identifier, never prose: a failure's text can echo what the user sent. */
const ERROR_CODE_PATTERN = /^[\w.:-]{1,64}$/;

const readField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

const readCode = (value: unknown): string | undefined => {
  const code = readField(value, 'code') ?? readField(value, 'type');
  return typeof code === 'string' ? code : undefined;
};

/**
 * The stable code a failed turn's text carries, read the way the message error registry reads
 * it (`components/Messages/Content/Error`): a LangChain code, else the `code` or `type` of the
 * embedded payload or of its `error` envelope. Anything else is `unclassified`.
 */
export function toErrorCode(text: string | undefined): string {
  if (!text) {
    return 'unclassified';
  }
  const langChainCode = parseLangChainErrorCode(text);
  if (langChainCode != null) {
    return langChainCode;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(extractJson(text));
  } catch {
    return 'unclassified';
  }
  const code = readCode(payload) ?? readCode(readField(payload, 'error'));
  return code != null && ERROR_CODE_PATTERN.test(code) ? code : 'unclassified';
}
