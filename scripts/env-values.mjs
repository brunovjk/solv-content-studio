/** Preserve access credentials, including numbered partner keys, during local reconfiguration. */
export function parseEnvValues(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>{
    const separator=line.indexOf("=");
    const raw=line.slice(separator+1).trim();
    let value=raw;
    if(raw.startsWith('"')&&raw.endsWith('"')) {
      try { value=JSON.parse(raw); } catch { value=raw.slice(1,-1); }
    } else if(raw.startsWith("'")&&raw.endsWith("'")) value=raw.slice(1,-1);
    return [line.slice(0,separator),value];
  }));
}
