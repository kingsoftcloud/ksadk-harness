import test from 'node:test';
import assert from 'node:assert/strict';
import { engineWebConfig } from '../src/native/engine-web-config.mjs';

test('engine search admits only configured real providers and never borrows the model credential', () => {
  for (const env of [{}, { AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'fake' },
    { AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'ksyun', AGENTKIT_ENGINE_MODEL_API_KEY: 'model-secret' },
    { AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'http', AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL: 'file:///tmp/search' },
    { AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'http', AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL: 'https://user:secret@example.com' }]) {
    assert.deepEqual(engineWebConfig(env), { configured: false, providerConfig: { provider: '' } });
  }
  const config = engineWebConfig({ KSADK_WEB_SEARCH_PROVIDER: ' KSYUN ', KSADK_MCP_KEY: 'search-secret' });
  assert.equal(config.configured, true);
  assert.deepEqual(config.providerConfig, { provider: 'ksyun', apiKey: 'search-secret', baseUrl: '', scope: 'webpage' });
  assert.equal(engineWebConfig({ AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'http',
    AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL: 'https://search.example.com' }).configured, true);
});
