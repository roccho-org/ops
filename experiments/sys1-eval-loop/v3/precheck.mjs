// Keyless audit fixed before looking at D626: does the D Gold treat template-only bodies as E = no like the held Gold?
// A body is template-like when, after removing HTML comments, headings, empty list/field lines and bare URLs or
// attachment links, fewer than 40 non-space characters of the reporter's own text remain.
export function residue(body){return String(body).replace(/<!--[\s\S]*?-->/g,'').split('\n').map(l=>l.trim()).filter(l=>l&&!/^#{1,6}\s/.test(l)&&!/^[-*]?\s*(\[[ x]\])?\s*[^:]{0,60}:\s*$/.test(l)&&!/^(\d+\.|[-*])\s*$/.test(l)&&!/^\[?[^\]]*\]?\(?https?:\/\/\S+\)?$/.test(l)&&!/^<img\b[^>]*>$/.test(l)).join('').replace(/\s+/g,'');}
export const templateLike=body=>residue(body).length<40;
export function audit(rows){const out={cases:rows.length,templateLike:0,gold:{yes:0,no:0},ids:[]};for(const r of rows)if(templateLike(r.body)){out.templateLike++;out.gold[r.goldE]++;out.ids.push(r.id);}return out;}
