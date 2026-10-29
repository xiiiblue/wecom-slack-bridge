// Never log SDK messages, stacks, URLs, headers or arbitrary error codes.
const permanent = new Set(['not_authed', 'invalid_auth', 'token_revoked', 'account_inactive', 'user_removed_from_team', 'team_disabled', 'missing_scope', 'not_allowed_token_type']);
const transient = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'slack_webapi_request_error', 'slack_webapi_http_error', 'slack_webapi_rate_limited_error']);
export function connectionFailure(error) {
  const candidates = [error?.data?.error, error?.original?.data?.error, error?.original?.cause?.code, error?.original?.code, error?.cause?.code, error?.code];
  const fatal = candidates.find(code => permanent.has(code));
  const code = fatal || candidates.find(code => transient.has(code)) || 'unclassified';
  return { code, exitCode: fatal ? 78 : 1 };
}
// Socket reconnection is owned by the supervisor. Do not run a second SDK
// reconnect loop: its rejected timer promises can escape the application's catch.
export function observeSlack(client, { log, shutdown, isStopping }) {
  let connected = false;
  client.on('authenticated', () => { if (!isStopping()) log('slack_authenticated'); });
  client.on('connected', () => { if (!isStopping()) { connected = true; log('slack_connected'); } });
  client.on('disconnected', () => {
    connected = false;
    if (!isStopping()) { log('slack_disconnected'); void shutdown(1); }
  });
  client.on('error', error => {
    connected = false;
    if (!isStopping()) {
      const failure = connectionFailure(error);
      log('slack_connection_error', failure); void shutdown(failure.exitCode);
    }
  });
  return () => connected;
}
