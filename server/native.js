// QORE_NATIVE_REST is only for local rehearsals; hosted Workers always use Diana.
export const NATIVE_REST = globalThis.process?.env?.QORE_NATIVE_REST?.trim() || 'https://api-testnet.qore.host';
export const RECEIPTS = 'qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8';

export async function nativeRead(request, fetchImpl = fetch) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/native/')) return null;
  if (request.method !== 'GET') return Response.json({ error: 'GET required' }, { status: 405, headers: { Allow: 'GET' } });

  const receipt = pathname.match(/^\/api\/native\/receipts\/([1-9]\d{0,15})$/);
  const window = pathname.match(/^\/api\/native\/windows\/(qor1[023456789acdefghjklmnpqrstuvwxyz]{38})$/);
  const evmTx = pathname.match(/^\/api\/native\/evm-tx\/(0x[\da-fA-F]{64})$/);
  const smart = pathname.match(/^\/api\/native\/smart-account\/(qor1[023456789acdefghjklmnpqrstuvwxyz]{38})$/);
  if (smart) return smartAccount(smart[1], fetchImpl);
  let upstreamPath;
  let pick = (body) => body;
  if (receipt && Number.isSafeInteger(Number(receipt[1]))) {
    const query = btoa(JSON.stringify({ receipt: { id: Number(receipt[1]) } }));
    upstreamPath = '/cosmwasm/wasm/v1/contract/' + RECEIPTS + '/smart/' + encodeURIComponent(query);
  } else if (window) {
    upstreamPath = '/qorechain/pqc/v1/evm_window/' + window[1];
  } else if (evmTx) {
    // The Cosmos hash of an EVM transaction: the form the QoreChain explorer lists.
    upstreamPath = '/cosmos/tx/v1beta1/txs?query=' + encodeURIComponent("ethereum_tx.ethereumTxHash='" + evmTx[1].toLowerCase() + "'");
    pick = (body) => {
      const found = body?.tx_responses?.[0];
      return found ? { cosmosTx: found.txhash, height: found.height } : undefined;
    };
  } else {
    return Response.json({ error: 'Unknown Diana query' }, { status: 404 });
  }

  try {
    const response = await fetchImpl(NATIVE_REST + upstreamPath, {
      redirect: 'error', signal: AbortSignal.timeout(8500), headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502;
      return Response.json({ error: 'Diana query unavailable' }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
    const body = pick(await response.json());
    if (body === undefined) return Response.json({ error: 'Not found on Diana' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return Response.json(body, {
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return Response.json({ error: 'Diana query unavailable' }, { status: 502 });
  }
}

/**
 * The spending rules and linked keys QoreChain's abstractaccount module enforces for an account.
 * An account that never linked a key is not a smart account yet: Diana answers 404, and so is this
 * reported as { smartAccount: false } rather than an error.
 */
async function smartAccount(address, fetchImpl) {
  const base = NATIVE_REST + '/qorechain/abstractaccount/v1/accounts/' + address;
  const get = async (path) => {
    const response = await fetchImpl(base + path, { redirect: 'error', signal: AbortSignal.timeout(8500), headers: { Accept: 'application/json' } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('upstream ' + response.status);
    return response.json();
  };
  try {
    const [rules, keys] = await Promise.all([get('/spending_rules'), get('/authenticators')]);
    const body = {
      smartAccount: Boolean(rules?.rules?.length || keys?.authenticators?.length),
      rules: (rules?.rules ?? []).map((rule) => ({
        id: String(rule.id ?? ''), enabled: rule.enabled === true, perTxLimit: String(rule.per_tx_limit ?? '0'), dailyLimit: String(rule.daily_limit ?? '0'),
        allowedDenoms: (rule.allowed_denoms ?? []).map(String), allowedEvmCalls: (rule.allowed_evm_calls ?? []).map(String),
      })),
      authenticators: (keys?.authenticators ?? []).map((key) => ({
        scheme: String(key.scheme ?? ''), pubkeyHex: String(key.pubkey_hex ?? ''), permissions: (key.permissions ?? []).map(String),
        expiryUnix: String(key.expiry_unix ?? '0'), label: String(key.label ?? '').slice(0, 80), revoked: key.revoked === true,
      })),
    };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return Response.json({ error: 'Diana query unavailable' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
