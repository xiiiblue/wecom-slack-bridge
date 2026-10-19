import { resolve } from 'node:path';
import { validDownloadHost } from './attachments.js';
export function loadConfig(env = process.env) {
  const required = key => { const value = env[key]?.trim(); if (!value) throw new Error(`Missing ${key}`); return value; };
  const list = key => new Set((env[key] || '').split(',').map(x => x.trim()).filter(Boolean));
  const integer = (key, fallback, max) => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${key}`); return n; };
  const config = {
    wecomBotId: required('WECOM_BOT_ID'), wecomSecret: required('WECOM_BOT_SECRET'),
    ownerUser: required('WECOM_OWNER_USER_ID'), allowedChats: list('WECOM_ALLOWED_CHAT_IDS'),
    slackToken: required('SLACK_BOT_TOKEN'), slackAppToken: required('SLACK_APP_TOKEN'),
    slackChannel: required('SLACK_CHANNEL_ID'), replyBot: env.SLACK_REPLY_BOT_ID?.trim(), replyUser: env.SLACK_REPLY_USER_ID?.trim(),
    feedbackRepositories: list('FEEDBACK_ALLOWED_REPOSITORIES'), feedbackUser: env.FEEDBACK_REPLY_USER_ID?.trim(),
    stateDir: resolve(env.STATE_DIR || './data'), ttlMs: integer('REPLY_TTL_SECONDS', 3600, 86400) * 1000,
    maxBytes: integer('MAX_MESSAGE_BYTES', 32000, 32000),
    attachmentsEnabled: env.WECOM_ATTACHMENTS_ENABLED === 'true', attachmentRepliesEnabled: env.WECOM_ATTACHMENT_REPLIES_ENABLED === 'true', attachmentUsers: list('WECOM_ATTACHMENT_ALLOWED_USER_IDS'),
    attachmentHosts: list('WECOM_ATTACHMENT_DOWNLOAD_HOSTS'), attachmentMaxCount: integer('MAX_ATTACHMENTS_PER_MESSAGE', 1, 3),
  };
  if (env.WECOM_ATTACHMENT_REPLIES_ENABLED && !['true','false'].includes(env.WECOM_ATTACHMENT_REPLIES_ENABLED)) throw new Error('Invalid WECOM_ATTACHMENT_REPLIES_ENABLED');
  if (env.WECOM_ATTACHMENTS_ENABLED && !['true','false'].includes(env.WECOM_ATTACHMENTS_ENABLED)) throw new Error('Invalid WECOM_ATTACHMENTS_ENABLED');
  if (config.attachmentsEnabled && (!config.attachmentHosts.size || [...config.attachmentHosts].some(host => !validDownloadHost(host)))) throw new Error('Attachments require verified official download host allowlist');
  if ([...config.feedbackRepositories].some(repo => !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(repo))) throw new Error('Invalid FEEDBACK_ALLOWED_REPOSITORIES');
  if (config.feedbackRepositories.size && !/^[UW][A-Z0-9]+$/.test(config.feedbackUser || '')) throw new Error('Feedback requires FEEDBACK_REPLY_USER_ID');
  if (config.feedbackRepositories.size && !config.replyBot) throw new Error('Feedback requires fixed reply bot');
  if (!config.allowedChats.size) throw new Error('WECOM_ALLOWED_CHAT_IDS must not be empty');
  if (config.allowedChats.has(config.ownerUser)) throw new Error('Owner ID must not be a group destination');
  if (Boolean(config.replyBot) === Boolean(config.replyUser)) throw new Error('Set exactly one SLACK_REPLY_BOT_ID or SLACK_REPLY_USER_ID');
  if (!/^[CG][A-Z0-9]+$/.test(config.slackChannel)) throw new Error('SLACK_CHANNEL_ID must be a channel ID');
  if (config.replyBot && !/^B[A-Z0-9]+$/.test(config.replyBot)) throw new Error('Invalid SLACK_REPLY_BOT_ID');
  if (config.replyUser && !/^[UW][A-Z0-9]+$/.test(config.replyUser)) throw new Error('Invalid SLACK_REPLY_USER_ID');
  return config;
}
