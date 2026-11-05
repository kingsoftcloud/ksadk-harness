const contract = 'agentkit.native-session-tool-approval/v1';
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

/** Optional addition to the Host's existing one-call approval card. */
export function createNativeApprovalActions({ React: { createElement: h, useState, useRef, useEffect }, hostRemote, Button = 'button' }) {
  return function NativeApprovalActions({ pending }) {
    const [waiting, setWaiting] = useState(false), [failure, setFailure] = useState(null);
    const busy = useRef(false), alive = useRef(true), staleOffer = useRef(null);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const offer = pending?.sessionGrant;
    if (offer?.contract !== contract || typeof hostRemote?.grantNativeSessionTool !== 'function'
      || !['offerId', 'requestId', 'agentId', 'sessionId', 'runId', 'toolName', 'targetSessionId'].every(key => validId(offer[key]))
      || pending.sessionId !== offer.sessionId || pending.toolName !== offer.toolName
      || typeof pending.answer !== 'function') return null;
    const stale = staleOffer.current === offer.offerId;
    const error = failure?.offerId === offer.offerId ? failure.message : '';
    const allow = async () => {
      if (busy.current || staleOffer.current === offer.offerId || !pending.answerable) return;
      busy.current = true; setWaiting(true); setFailure(null);
      try {
        const request = Object.fromEntries(['agentId', 'sessionId', 'runId', 'offerId', 'requestId'].map(key => [key, offer[key]]));
        const receipt = await hostRemote.grantNativeSessionTool(request);
        if (!['accepted', 'duplicate'].includes(receipt?.status) || receipt.offerId !== offer.offerId || receipt.requestId !== offer.requestId)
          throw Error('unconfirmed Session grant');
        if (alive.current && pending.answerable) await pending.answer('allowed-once');
      } catch (cause) {
        const invalid = ['session_tool_approval_offer_stale', 'studio_native_session_approval_stale'].includes(cause?.code);
        if (invalid) staleOffer.current = offer.offerId;
        if (alive.current) setFailure({ offerId: offer.offerId, message: invalid
          ? '这次会话授权已失效，请选择“允许一次”继续当前操作。'
          : '会话授权尚未确认，请重试或选择仅允许一次。' });
      } finally { busy.current = false; if (alive.current) setWaiting(false); }
    };
    return h('span', null, h(Button, { type: 'button', variant: 'outline', disabled: waiting || stale || !pending.answerable,
      title: `仅记住 ${offer.toolName} 在当前构建及会话运行期间的 Agent 额外审批；Host 和沙箱限制仍然有效。重启或权限变更后需要重新确认。`,
      onClick: allow }, waiting ? '确认授权中…' : stale ? '会话授权已失效' : offer.targetSessionId === offer.sessionId ? '本会话允许此工具' : '本子任务会话允许此工具'),
    error ? h('span', { role: 'alert' }, error) : null);
  };
}
