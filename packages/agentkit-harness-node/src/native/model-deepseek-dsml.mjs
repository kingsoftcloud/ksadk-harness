const markerHeads = ['<', '</'].flatMap(start => ['|', '||'].flatMap(left =>
  ['||', '|'].map(right => `${start}${left}DSML${right}`)));
const maxHeadLength = Math.max(...markerHeads.map(head => head.length));
const tagNames = ['calls', 'tool_calls', 'function_calls', 'invoke', 'parameter'];
const tagPrefix = /^(calls|tool_calls|function_calls|invoke|parameter)(?=[\t />])/u;

export function createDeepSeekContentProjector(binding) {
  // Gate on the model ID so DeepSeek behind an OpenAI-compatible proxy behaves
  // the same as a direct connection, and other models keep their wire content.
  if (!/(?:^|[/.:])deepseek[-_.]v(?:3[._-]2|4)(?=$|[._:-])/iu.test(binding?.model ?? '')) {
    return { push: text => text, seal: () => '' };
  }
  let pending = '';
  let hiddenBlock = null;
  let codeDelimiter = '';

  function read(text, sealed) {
    pending += text;
    let visible = '';
    while (pending) {
      const special = pending.search(/[<`~]/u);
      const length = special < 0 ? pending.length : special;
      if (length) {
        if (!hiddenBlock) visible += pending.slice(0, length);
        pending = pending.slice(length);
        continue;
      }

      if (pending[0] !== '<') {
        const delimiter = pending.match(/^(?:`+|~+)/u)[0];
        if (!sealed && delimiter.length === pending.length) break;
        if (!hiddenBlock) {
          if (codeDelimiter) {
            if (delimiter === codeDelimiter || codeDelimiter.length >= 3 &&
                delimiter[0] === codeDelimiter[0] && delimiter.length > codeDelimiter.length) {
              codeDelimiter = '';
            }
          } else if (delimiter[0] === '`' || delimiter.length >= 3) {
            codeDelimiter = delimiter;
          }
          visible += delimiter;
        }
        pending = pending.slice(delimiter.length);
        continue;
      }

      if (!codeDelimiter) {
        const prefix = pending.slice(0, maxHeadLength).replaceAll('｜', '|');
        if (markerHeads.some(head => head.startsWith(prefix))) {
          if (!sealed) break;
          if (prefix.endsWith('DSML')) {
            pending = '';
            break;
          }
        }
        const head = markerHeads.find(candidate => prefix.startsWith(candidate));
        if (head) {
          const afterHead = pending.slice(head.length);
          const rest = afterHead.replace(/^[\t ]+/u, '');
          const tag = rest.match(tagPrefix)?.[1];
          if (tag) {
            const end = pending.indexOf('>', head.length);
            if (end < 0 && !sealed) break;
            const closing = head.startsWith('</');
            if (closing && tag === hiddenBlock) hiddenBlock = null;
            if (!closing && !hiddenBlock && end >= 0 && pending[end - 1] !== '/') hiddenBlock = tag;
            pending = end < 0 ? '' : pending.slice(end + 1);
            continue;
          }
          if (tagNames.some(name => name.startsWith(rest))) {
            if (!sealed) break;
            pending = '';
            continue;
          }
        }
      }
      if (!hiddenBlock) visible += '<';
      pending = pending.slice(1);
    }
    return visible;
  }

  // Only transport markup is suppressed. Executable calls still come from the
  // provider's structured tool_calls channel and its existing validation path.
  return { push: text => read(text, false), seal: () => read('', true) };
}
