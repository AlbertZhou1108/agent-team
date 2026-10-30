/** @param {unknown} name @returns {any} */
export function streamMessageToolName(name) {
  if (typeof name !== 'string') return name;
  if (name.startsWith('mcp__agent_team__')) return name.slice('mcp__agent_team__'.length);
  if (name.startsWith('agent_team_')) return name.slice('agent_team_'.length);
  return name;
}

/** @param {string} value @param {string} key */
export function partialJsonString(value, key) {
  /** @param {number} start */
  function readString(start) {
    let encoded = '';
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === '\\') {
        if (index + 1 >= value.length) {
          return { closed: false, end: index, value: null };
        }
        encoded += character + value[index + 1];
        index += 1;
        continue;
      }
      if (character === '"') {
        try {
          return {
            closed: true,
            end: index,
            value: JSON.parse(`"${encoded}"`),
          };
        } catch {
          return { closed: true, end: index, value: null };
        }
      }
      encoded += character;
    }
    try {
      return { closed: false, end: value.length, value: JSON.parse(`"${encoded}"`) };
    } catch {
      return { closed: false, end: value.length, value: null };
    }
  }

  let depth = 0;
  let previousSignificant = '';
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === '"') {
      const token = readString(index);
      if (depth === 1 && (previousSignificant === '{' || previousSignificant === ',') && token.closed) {
        let next = token.end + 1;
        while (/\s/.test(value[next] ?? '')) next += 1;
        if (value[next] === ':') {
          next += 1;
          while (/\s/.test(value[next] ?? '')) next += 1;
          if (token.value === key) {
            if (value[next] !== '"') return null;
            return readString(next).value;
          }
        }
      }
      previousSignificant = '"';
      index = token.end + 1;
      continue;
    }
    if (!/\s/.test(character)) {
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
      previousSignificant = character;
    }
    index += 1;
  }
  return null;
}

