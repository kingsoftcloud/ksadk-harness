// Search configuration belongs to the independent engine, not to its UI host.
// Resolve once at startup; credentials must never be returned by info().
export function engineWebConfig(env = {}) {
  const read = (...names) => names.map(name => String(env[name] ?? '').trim()).find(Boolean) || '';
  const provider = read('AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER', 'KSADK_WEB_SEARCH_PROVIDER', 'OPENCLAW_WEB_SEARCH_PROVIDER').toLowerCase();
  const baseUrl = read('AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL', 'KSADK_WEB_SEARCH_BASE_URL', 'OPENCLAW_WEB_SEARCH_BASE_URL');
  const apiKey = read('AGENTKIT_ENGINE_WEB_SEARCH_API_KEY', 'KSADK_WEB_SEARCH_API_KEY', 'OPENCLAW_WEB_SEARCH_API_KEY',
    ...(provider === 'ksyun' ? ['KSADK_MCP_KEY', 'KSC_AIPRO_API_KEY', 'KSC_AIPRO_APIKEY', 'AIPRO_API_KEY'] : []));
  const scope = read('AGENTKIT_ENGINE_WEB_SEARCH_SCOPE', 'KSADK_WEB_SEARCH_SCOPE') || 'webpage';
  const validUrl = value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  };
  const configured = provider === 'http' && validUrl(baseUrl)
    || provider === 'ksyun' && Boolean(apiKey) && (!baseUrl || validUrl(baseUrl));
  return { configured, providerConfig: configured ? { provider, baseUrl, apiKey, scope } : { provider: '' } };
}
